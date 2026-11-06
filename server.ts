import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { createHostySessionResponse } from "@hosty-sdk/app/session/server";
import { createHostyUiResponse } from "@hosty-sdk/app/ui/server";
import { readAppCredential, resolveAppSession, getAppRecoveryParams, exchangeLaunchCode } from "./auth.js";

async function body(request: IncomingMessage, maxBytes = 65536) {
  let text = "";
  for await (const chunk of request) {
    text += chunk.toString();
    if (Buffer.byteLength(text) > maxBytes) throw new Error("Request too large.");
  }
  return JSON.parse(text || "{}");
}
createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://" + request.headers.host);
  const send = (status: number, value: unknown) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(value));
  };
  try {
    if (request.method === "GET" && url.pathname === "/healthz") return send(200, { status: "ok" });
    if (request.method === "GET" && ["/", "/client.js"].includes(url.pathname)) {
      response.setHeader("cache-control", "no-store");
      if (url.pathname === "/") {
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(await readFile(new URL("./index.html", import.meta.url))); return;
      }
      const result = await build({ entryPoints: ["client.tsx"], bundle: true, write: false, format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' } });
      response.setHeader("content-type", "text/javascript; charset=utf-8");
      response.end(result.outputFiles[0].contents); return;
    }
    if (request.method === "POST") {
      const origin = request.headers.origin;
      if (!origin || new URL(origin).host !== request.headers.host) return send(403, { message: "Same-origin request required." });
    }
    if (request.method === "POST" && url.pathname === "/api/auth/app-code") {
      const input = await body(request);
      const result = await exchangeLaunchCode(input.code, input.codeVerifier, request.headers["x-forwarded-proto"] === "https");
      if (!result.ok) return send(result.status, result);
      response.setHeader("set-cookie", result.setCookie);
      return send(200, { accessToken: result.accessToken, expiresInSeconds: result.expiresInSeconds, activeUntil: result.activeUntil });
    }
    const token = readAppCredential(request);
    const session = await resolveAppSession(token);
    if (request.method === "GET" && url.pathname === "/api/auth/identity")
      return send(200, { ...session, ...(session.status === "active" ? session.identity : {}), recovery: await getAppRecoveryParams() });
    if (request.method === "GET" && url.pathname === "/api/hosty/session") {
      const result = await createHostySessionResponse(session, await getAppRecoveryParams());
      return send(result.status, await result.json());
    }
    if (url.pathname.startsWith("/api/hosty/ui/")) {
      const result = await createHostyUiResponse(new Request(url, { method: request.method, headers: Object.fromEntries(Object.entries(request.headers).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
        body: request.method === "POST" ? JSON.stringify(await body(request, url.pathname.includes("/feedback") ? 12 * 1024 * 1024 : 65536)) : undefined }),
        { session, token });
      const bytes = Buffer.from(await result.arrayBuffer());
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(bytes); return;
    }
    if (session.status !== "active") return send(session.status === "forbidden" ? 403 : session.status === "unavailable" || session.status === "misconfigured" ? 503 : 401, { status: session.status });
    if (request.method === "GET" && url.pathname === "/api/app") {
      const manifest = JSON.parse(await readFile(new URL("./manifest.json", import.meta.url), "utf8"));
      return send(200, { name: manifest.name, description: manifest.description });
    }
    send(404, { message: "Not found." });
  } catch { send(503, { message: "Application is unavailable. Check its logs and retry." }); }
}).listen(3000, "0.0.0.0");
