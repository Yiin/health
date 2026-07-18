// Drive-by basic-auth gate. Tailscale already restricts network access to the
// tailnet, so this only keeps casual browsers out — it is not real auth.
// When BASIC_AUTH_USER / BASIC_AUTH_PASS are unset, everything passes through.

export interface BasicAuthConfig {
  user?: string;
  pass?: string;
}

export function isBasicAuthEnabled(config: BasicAuthConfig): boolean {
  return Boolean(config.user && config.pass);
}

export function parseBasicAuthHeader(
  header: string | null,
): { user: string; pass: string } | null {
  if (!header || !header.startsWith("Basic ")) return null;
  let decoded: string;
  try {
    decoded = atob(header.slice("Basic ".length));
  } catch {
    return null;
  }
  const sep = decoded.indexOf(":");
  if (sep === -1) return null;
  return { user: decoded.slice(0, sep), pass: decoded.slice(sep + 1) };
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function isAuthorized(
  config: BasicAuthConfig,
  authorizationHeader: string | null,
): boolean {
  if (!isBasicAuthEnabled(config)) return true;
  const creds = parseBasicAuthHeader(authorizationHeader);
  if (!creds) return false;
  return (
    safeEqual(creds.user, config.user as string) &&
    safeEqual(creds.pass, config.pass as string)
  );
}

/**
 * Env-configured check shared by the proxy (src/proxy.ts) and API routes that
 * must bypass the proxy (streaming uploads — see the proxy's matcher).
 */
export function isRequestAuthorized(request: Request): boolean {
  return isAuthorized(
    { user: process.env.BASIC_AUTH_USER, pass: process.env.BASIC_AUTH_PASS },
    request.headers.get("authorization"),
  );
}

/** The 401 shape the proxy and self-gating routes both answer with. */
export function authenticationRequiredResponse(): Response {
  return new Response("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="health"' },
  });
}
