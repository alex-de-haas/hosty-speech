import { readAppContinuity, type AppContinuity } from "@hosty-sdk/app/continuity";
import type { IncomingMessage } from "node:http";
import { isValidCodeVerifier, resolveAppAuthProtocol, appAuthProtocolMinimum } from "@hosty-sdk/app/app-code";

// Validating this app's own Hosty session for its browser API.
//
// Deliberately not `@hosty-sdk/app/server`: that entry is the SDK's **Next** server slice — it opens
// with `import "server-only"`, which throws outside a React server environment, and it is written
// for bundler module resolution. This app is a plain Node process, so importing it pulls a
// framework contract into a service that has no framework. What is actually needed is one POST.
//
// The endpoint and its classification are Core's contract, shared with the SDK rather than invented
// here: `POST /api/auth/apps/revalidate` with the app service token, and the status taxonomy below
// keyed on HTTP status only — never on error-code strings, so a new Core code cannot break this app.

export const identityCookieName = "hosty_app_identity";

export async function getAppRecoveryParams() {
  return { appId: process.env.HOSTY_APP_ID ?? "", corePublicOrigin: process.env.HOSTY_CORE_PUBLIC_ORIGIN ?? null,
    appAuthProtocol: await resolveAppAuthProtocol(process.env.HOSTY_CORE_ORIGIN?.trim() || null) };
}

export type AppSessionIdentity = { userId: string; hostRole: string | null; activeUntil?: string | null; activityRequired?: boolean; continuity?: AppContinuity };

export type AppSessionResult =
  | { status: "active"; identity: AppSessionIdentity }
  | { status: "not-present" | "expired" | "forbidden" | "unavailable" | "misconfigured";
      error?: { status: number; code: string; message: string } };

export function readIdentityCookie(request: IncomingMessage): string | null {
  const header = request.headers.cookie;
  if (!header) {
    return null;
  }

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0 && part.slice(0, separator).trim() === identityCookieName) {
      try {
        return decodeURIComponent(part.slice(separator + 1).trim()) || null;
      } catch {
        // A Cookie header is untrusted input, and `decodeURIComponent` throws on malformed
        // percent-encoding. A value this app could not have written is no credential, so it reads
        // as absent rather than crashing the request.
        return null;
      }
    }
  }

  return null;
}

export function readAppCredential(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer hostyg_")) return authorization.slice(7).trim();
  return readIdentityCookie(request);
}

export async function resolveAppSession(token: string | null): Promise<AppSessionResult> {
  if (!token) {
    return { status: "not-present" };
  }

  const coreOrigin = process.env.HOSTY_CORE_ORIGIN?.trim();
  const serviceToken = process.env.HOSTY_APP_SERVICE_TOKEN?.trim();
  if (!coreOrigin || !serviceToken) {
    // An operator problem, not a caller problem: the app was started outside Core, or by a Core too
    // old to inject these. Reported as its own status so the page can say which.
    return { status: "misconfigured" };
  }

  let response: Response;
  try {
    response = await fetch(new URL("/api/auth/apps/revalidate", coreOrigin), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${serviceToken}` },
      body: JSON.stringify({ accessToken: token }),
    });
  } catch {
    // Core unreachable is transient and must not read as "refused": the difference decides whether
    // the operator waits or goes looking for a permissions problem.
    return { status: "unavailable" };
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null) as
      { code?: unknown; message?: unknown; error?: { code?: unknown; message?: unknown } } | null;
    const error = body?.error ?? body;
    return { status: classifyRevalidationStatus(response.status), error: {
      status: response.status,
      code: typeof error?.code === "string" ? error.code : "app_session_revalidation_failed",
      message: typeof error?.message === "string" ? error.message : "Core could not validate this app session.",
    } };
  }

  // Core's shape, flattened — `AppSessionValidationResult` in AppIdentityService.cs, serialized with
  // `JsonSerializerDefaults.Web`. `active` is checked rather than assumed from the 2xx: it is the
  // field that carries the answer, and reading only the identity would let a future negative result
  // pass as a session.
  const payload = (await response.json().catch(() => null)) as
    | { active?: unknown; userId?: unknown; hostRole?: unknown; activeUntil?: unknown; activityRequired?: unknown; continuity?: unknown }
    | null;
  const userId = typeof payload?.userId === "string" ? payload.userId : "";
  if (payload?.active !== true || !userId) {
    return { status: "unavailable" };
  }

  return {
    status: "active",
    identity: { userId, hostRole: typeof payload.hostRole === "string" ? payload.hostRole : null, activeUntil: typeof payload.activeUntil === "string" ? payload.activeUntil : null, activityRequired: payload.activityRequired === true, continuity: readAppContinuity(payload.continuity) },
  };
}

/** Core's normative table, by status code only. */
function classifyRevalidationStatus(status: number): Exclude<AppSessionResult["status"], "active"> {
  if (status === 401) {
    return "expired";
  }
  if (status === 403) {
    return "forbidden";
  }
  return status >= 500 ? "unavailable" : "expired";
}

/**
 * Trades a Hosty launch code for this app's session cookie.
 *
 * Core returns a code to this app through navigation or a popup. The server exchanges and
 * validates it against its own app identity before returning the app grant and cookie. HTTPS uses
 * SameSite=None so browsers that allow third-party cookies can send it from a cross-site frame.
 * Plain HTTP keeps SameSite=Lax; the SDK's own-app bearer covers frames without cookie access.
 */
export async function exchangeLaunchCode(
  code: string,
  codeVerifier: string,
  secure: boolean,
): Promise<{ ok: true; setCookie: string; accessToken: string; expiresInSeconds: number; activeUntil?: string | null } | { ok: false; status: number; code: string; message: string }> {
  if (!isValidCodeVerifier(codeVerifier))
    return { ok: false, status: 400, code: "app_auth_proof_required", message: "A valid Hosty sign-in proof is required." };
  const serviceToken = process.env.HOSTY_APP_SERVICE_TOKEN?.trim();
  if (!serviceToken) {
    return { ok: false, status: 503, code: "app_service_token_missing", message: "HOSTY_APP_SERVICE_TOKEN is not configured." };
  }
  const coreOrigin = process.env.HOSTY_CORE_ORIGIN?.trim();
  if (!coreOrigin) {
    return { ok: false, status: 503, code: "core_origin_missing", message: "HOSTY_CORE_ORIGIN is not configured." };
  }
  if (appAuthProtocolMinimum(coreOrigin) === 2 && await resolveAppAuthProtocol(coreOrigin) !== 2)
    return { ok: false, status: 503, code: "app_auth_protocol_unavailable", message: "Hosty sign-in protocol could not be verified." };

  let response: Response;
  try {
    response = await fetch(new URL("/api/auth/apps/token", coreOrigin), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${serviceToken}` },
      body: JSON.stringify({ code, codeVerifier }),
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(1_500),
    });
  } catch {
    return { ok: false, status: 503, code: "core_unreachable", message: "Hosty Core could not be reached." };
  }

  const payload = (await response.json().catch(() => null)) as
    | { accessToken?: unknown; expiresInSeconds?: unknown; message?: unknown }
    | null;
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      code: "app_code_rejected",
      message: typeof payload?.message === "string" ? payload.message : "Hosty Core rejected the launch code.",
    };
  }

  const accessToken = typeof payload?.accessToken === "string" ? payload.accessToken : null;
  if (!accessToken) {
    return { ok: false, status: 502, code: "app_identity_token_missing", message: "Core returned no usable identity token." };
  }

  const validation = await resolveAppSession(accessToken);
  if (validation.status !== "active") return { ok: false, status: validation.status === "unavailable" || validation.status === "misconfigured" ? 503 : 403,
    code: "app_identity_rejected", message: "Core could not validate this app session." };
  const maxAge = typeof payload?.expiresInSeconds === "number" ? Math.max(0, Math.floor(payload.expiresInSeconds)) : 3600;
  const attributes = [
    `${identityCookieName}=${encodeURIComponent(accessToken)}`,
    "HttpOnly",
    "Path=/",
    `Max-Age=${maxAge}`,
    `SameSite=${secure ? "None" : "Lax"}`,
    ...(secure ? ["Secure"] : []),
  ];
  return { ok: true, setCookie: attributes.join("; "), accessToken, expiresInSeconds: maxAge, activeUntil: validation.identity.activeUntil };
}
