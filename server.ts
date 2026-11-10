import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProviderClient } from "@hosty-sdk/app/providers/server";
import { createHostySessionResponse } from "@hosty-sdk/app/session/server";
import { createHostyUiResponse } from "@hosty-sdk/app/ui/server";
import { createThemeBootstrapScript } from "@hosty-sdk/app/theme";
import { readAppCredential, resolveAppSession, getAppRecoveryParams, exchangeLaunchCode, type AppSessionResult } from "./auth.js";
import { SpeechService } from "./src/service.js";
import { SpeechError } from "./src/errors.js";
import { MAX_BYTES } from "./src/wave.js";
import { INFERENCE_TIMEOUT_MS } from "./src/limits.js";

async function bytes(request: IncomingMessage, limit: number, signal?: AbortSignal): Promise<Buffer> {
  if (Number(request.headers["content-length"]) > limit) throw new SpeechError(413, "request_too_large", "The request exceeds the supported size.");
  const chunks: Buffer[] = []; let count = 0;
  for await (const chunk of request) {
    signal?.throwIfAborted(); const part = Buffer.from(chunk); count += part.length;
    if (count > limit) throw new SpeechError(413, "request_too_large", "The request exceeds the supported size.");
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}
async function json(request: IncomingMessage, limit = 8192) {
  try { return JSON.parse((await bytes(request, limit)).toString("utf8") || "{}"); }
  catch (error) { if (error instanceof SpeechError) throw error; throw new SpeechError(400, "request_invalid", "Send a valid JSON request."); }
}
function send(response: ServerResponse, status: number, value: unknown) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(value));
}
function isSecure(request: IncomingMessage) { return request.headers["x-forwarded-proto"] === "https" || Boolean((request.socket as { encrypted?: boolean }).encrypted); }
function sameOrigin(request: IncomingMessage, url: URL) {
  try { return typeof request.headers.origin === "string" && new URL(request.headers.origin).origin === url.origin; } catch { return false; }
}
type Dependencies = {
  service: SpeechService;
  resolveSession?: typeof resolveAppSession;
  validateProvider?: (token: string, signal: AbortSignal) => Promise<unknown>;
  assetsDirectory?: string;
};
export function createSpeechServer({ service, resolveSession = resolveAppSession, validateProvider, assetsDirectory }: Dependencies) {
  const here = dirname(fileURLToPath(import.meta.url));
  const assets = assetsDirectory ?? (existsSync(join(here, "client.js")) ? here : join(here, "dist"));
  let streams = 0;
  const server = createServer(async (request, response) => {
    const cancelled = new AbortController();
    const abort = () => { if (!response.writableEnded) cancelled.abort(); };
    response.once("close", abort);
    const signal = AbortSignal.any([cancelled.signal, AbortSignal.timeout(INFERENCE_TIMEOUT_MS + 10_000)]);
    try {
      const host = request.headers.host;
      if (!host || /[\s/\\]/.test(host)) throw new SpeechError(400, "request_invalid", "Invalid request host.");
      const url = new URL(request.url ?? "/", `${isSecure(request) ? "https" : "http"}://${host}`);
      if (request.method === "GET" && url.pathname === "/healthz") return send(response, 200, { status: "running" });

      // Provider authority is validated independently of browser login and before reading audio.
      if (url.pathname.startsWith("/api/speech/v1/")) {
        const header = request.headers.authorization;
        if (!header?.startsWith("Bearer ") || !header.slice(7).trim()) throw new SpeechError(401, "provider_required", "A speech-provider credential is required.");
        if (validateProvider) await validateProvider(header.slice(7).trim(), signal);
        else await new ProviderClient().validate(header.slice(7).trim(), "speech-to-text", "default", signal);
        if (request.method === "GET" && url.pathname === "/api/speech/v1/capabilities") return send(response, 200, service.capabilities());
        if (request.method === "POST" && url.pathname === "/api/speech/v1/transcriptions") {
          if (request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "audio/wav") throw new SpeechError(415, "speech_format_unsupported", "Use a 16 kHz mono PCM16 WAV recording.");
          const declaredMaximum = service.capabilities().maxBytes;
          const maximum = Number.isFinite(declaredMaximum) && declaredMaximum > 0 ? Math.min(MAX_BYTES, declaredMaximum) : MAX_BYTES;
          const audio = await bytes(request, maximum, signal);
          return send(response, 200, await service.transcribe(audio, url.searchParams.get("language") || "auto", signal));
        }
        throw new SpeechError(404, "not_found", "Unknown speech operation.");
      }

      if (request.method === "GET" && ["/", "/settings", "/client.js", "/styles.css"].includes(url.pathname)) {
        response.setHeader("cache-control", "no-store"); response.setHeader("x-content-type-options", "nosniff");
        if (url.pathname === "/" || url.pathname === "/settings") {
          const html = (await readFile(join(assets, "index.html"), "utf8")).replace("<!-- hosty:theme-bootstrap -->", `<script>${createThemeBootstrapScript()}</script>`);
          response.setHeader("content-type", "text/html; charset=utf-8"); response.end(html);
        } else {
          response.setHeader("content-type", url.pathname === "/client.js" ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8");
          response.end(await readFile(join(assets, url.pathname.slice(1))));
        }
        return;
      }
      if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method ?? "") && !sameOrigin(request, url)) throw new SpeechError(403, "same_origin_required", "A same-origin request is required.");
      if (request.method === "POST" && url.pathname === "/api/auth/app-code") {
        const input = await json(request);
        if (!input || typeof input !== "object" || typeof input.code !== "string" || typeof input.codeVerifier !== "string") throw new SpeechError(400, "app_code_invalid", "A Hosty sign-in proof is required.");
        const result = await exchangeLaunchCode(input.code, input.codeVerifier, isSecure(request));
        if (!result.ok) return send(response, result.status, { code: result.code, message: result.message });
        response.setHeader("set-cookie", result.setCookie);
        return send(response, 200, { accessToken: result.accessToken, expiresInSeconds: result.expiresInSeconds, activeUntil: result.activeUntil });
      }
      const token = readAppCredential(request);
      const session = await resolveSession(token);
      if (request.method === "GET" && url.pathname === "/api/auth/identity") return send(response, 200, { ...session, ...(session.status === "active" ? session.identity : {}), recovery: await getAppRecoveryParams() });
      if (request.method === "GET" && url.pathname === "/api/hosty/session") {
        const result = await createHostySessionResponse(session, await getAppRecoveryParams()); return send(response, result.status, await result.json());
      }
      if (url.pathname.startsWith("/api/hosty/ui/")) {
        const result = await createHostyUiResponse(new Request(url, {
          method: request.method,
          headers: Object.fromEntries(Object.entries(request.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
          body: request.method === "POST" ? JSON.stringify(await json(request, url.pathname.includes("/feedback") ? 12 * 1024 * 1024 : 8192)) : undefined,
        }), { session, token });
        response.writeHead(result.status, Object.fromEntries(result.headers)); response.end(Buffer.from(await result.arrayBuffer())); return;
      }
      requireAdministrator(session);
      if (request.method === "GET" && url.pathname === "/api/settings") return send(response, 200, service.snapshot());
      if (request.method === "POST" && url.pathname === "/api/settings") { service.activate(await json(request)); return send(response, 202, service.snapshot()); }
      if (request.method === "POST" && url.pathname === "/api/recording-settings") { await service.configureRecording(await json(request)); return send(response, 200, service.snapshot()); }
      const modelAction = /^\/api\/models\/([a-z0-9.-]+)\/(download|cancel|delete)$/.exec(url.pathname);
      if (request.method === "POST" && modelAction) {
        await json(request);
        if (modelAction[2] === "download") service.downloads.start(modelAction[1]!);
        else if (modelAction[2] === "cancel") await service.downloads.cancel(modelAction[1]!);
        else await service.removeModel(modelAction[1]!);
        return send(response, modelAction[2] === "download" ? 202 : 200, service.snapshot());
      }
      if (request.method === "GET" && url.pathname === "/api/events") {
        if (streams >= 32) throw new SpeechError(429, "streams_busy", "Too many settings pages are connected. Close another tab and retry.");
        streams++; response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-store", connection: "keep-alive", "x-accel-buffering": "no" });
        response.flushHeaders();
        const write = () => { if (!response.destroyed && !response.write(`event: state\ndata: ${JSON.stringify(service.snapshot())}\n\n`)) response.destroy(); };
        let checking = false;
        const keepalive = setInterval(async () => {
          if (checking) return; checking = true;
          try {
            const current = await resolveSession(token);
            if (current.status !== "active" || current.identity.hostRole !== "host.admin") {
              response.write(`event: access\ndata: ${JSON.stringify({ status: current.status === "active" || current.status === "forbidden" ? 403 : 401 })}\n\n`); response.end();
            } else response.write(": keep-alive\n\n");
          } finally { checking = false; }
        }, 15_000); keepalive.unref();
        write(); service.on("change", write);
        response.once("close", () => { streams--; clearInterval(keepalive); service.off("change", write); });
        return;
      }
      throw new SpeechError(404, "not_found", "Not found.");
    } catch (error) {
      if (signal.aborted) return send(response, cancelled.signal.aborted ? 499 : 504, { code: "speech_cancelled", message: "Recognition was cancelled or timed out." });
      const value = error as { status?: unknown; code?: unknown; message?: unknown };
      const status = typeof value.status === "number" && value.status >= 400 && value.status <= 599 ? value.status : 503;
      const code = typeof value.code === "string" ? value.code : "speech_unavailable";
      const message = status < 500 && typeof value.message === "string" ? value.message : "Speech is unavailable. Check its status and retry.";
      send(response, status, { code, message });
    }
  });
  server.requestTimeout = INFERENCE_TIMEOUT_MS + 20_000; server.headersTimeout = 15_000;
  return server;
}
function requireAdministrator(session: AppSessionResult) {
  if (session.status !== "active") throw new SpeechError(session.status === "forbidden" ? 403 : session.status === "unavailable" || session.status === "misconfigured" ? 503 : 401, "app_access_required", "Sign in to Hosty to manage speech settings.");
  if (session.identity.hostRole !== "host.admin") throw new SpeechError(403, "admin_required", "Only a Hosty administrator can change shared speech settings.");
}
export async function start(options: { service?: SpeechService; port?: number } = {}) {
  const data = process.env.HOSTY_APP_DATA_DIR, cache = process.env.HOSTY_APP_CACHE_DIR;
  if (!data || !cache || !process.env.HOSTY_APP_ID || !process.env.HOSTY_APP_SERVICE_TOKEN || !process.env.HOSTY_CORE_ORIGIN) throw new Error("Launch Hosty Speech through its Core-managed runtime.");
  const port = options.port ?? Number(process.env.HOSTY_PORT_HTTP ?? process.env.PORT ?? 3520);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("The assigned HTTP port is invalid.");
  const service = options.service ?? new SpeechService(data, cache);
  let server: ReturnType<typeof createSpeechServer>;
  try {
    await service.initialize(); server = createSpeechServer({ service });
    // Native providers must be reachable through the host gateway by Docker consumers on Linux.
    await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(port, "0.0.0.0", resolveListen); });
  } catch (error) { await service.close(); throw error; }
  console.info("Hosty Speech is running.");
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => { server.close(); server.closeAllConnections(); await service.close(); })();
  const onSignal = () => { void stop().catch(() => { console.error("The speech worker did not confirm shutdown."); process.exitCode = 1; }); };
  process.once("SIGTERM", onSignal); process.once("SIGINT", onSignal);
  server.once("close", () => { process.off("SIGTERM", onSignal); process.off("SIGINT", onSignal); });
  return { server, service, stop };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().catch(() => { console.error("Hosty Speech failed to start. Check the configured runtime and app storage."); process.exitCode = 1; });
}

