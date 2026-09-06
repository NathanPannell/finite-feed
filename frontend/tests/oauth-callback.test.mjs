import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { processAuthMiddleware, DEFAULT_AUTH_SKIP_ROUTES } from "@neondatabase/auth/server";
import { finishOAuthRedirect } from "../lib/auth/callback.ts";

test("OAuth verifier is exchanged for a session cookie before leaving callback", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    return Response.json({ session: { id: "session", userId: "user", token: "token", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z" }, user: { id: "user", name: "Tester", email: "tester@example.test", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" } }, {
      headers: { "Set-Cookie": "__Secure-neon-auth.session_token=token; Path=/; HttpOnly; Secure; SameSite=Lax" },
    });
  };
  try {
    const result = await processAuthMiddleware({
      request: new Request("https://finite.example/auth/callback?neon_auth_session_verifier=verifier", { headers: { Cookie: "__Secure-neon-auth.session_challenge=challenge" } }),
      pathname: "/auth/callback", skipRoutes: DEFAULT_AUTH_SKIP_ROUTES,
      loginUrl: "/auth/sign-in", baseUrl: "https://auth.example/auth",
      cookieSecret: "isolated-test-cookie-secret-at-least-32-characters", sessionDataTtl: 1,
    });
    assert.equal(result.action, "redirect_oauth");
    assert.equal(result.redirectUrl.search, "");
    assert.ok(result.cookies.some(cookie => cookie.startsWith("__Secure-neon-auth.session_token=")));
    assert.ok(calls.some(url => url.includes("get-session") && url.includes("neon_auth_session_verifier=verifier")));
  } finally { globalThis.fetch = originalFetch; }
});

test("failed verifier on root or app returns to sign-in without leaking verifier or losing cookies", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 401 });
  try {
    for (const pathname of ["/", "/app"]) {
      const requestUrl = `https://finite.example${pathname}?neon_auth_session_verifier=expired`;
      const result = await processAuthMiddleware({
        request: new Request(requestUrl, { headers: { Cookie: "__Secure-neon-auth.session_challenge=challenge" } }),
        pathname, skipRoutes: DEFAULT_AUTH_SKIP_ROUTES,
        loginUrl: "/auth/sign-in", baseUrl: "https://auth.example/auth",
        cookieSecret: "isolated-test-cookie-secret-at-least-32-characters", sessionDataTtl: 1,
      });
      assert.equal(result.action, "redirect_login");
      const cookie = "__Secure-neon-auth.session_token=; Max-Age=0; Secure; HttpOnly";
      const response = new Response(null, { status: 307, headers: { Location: result.redirectUrl.href, "Set-Cookie": cookie } });
      assert.equal(finishOAuthRedirect(response, requestUrl), response);
      assert.equal(response.headers.get("location"), "https://finite.example/login");
      assert.equal(response.headers.get("set-cookie"), cookie);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("successful OAuth completion enters onboarding directly", () => {
  const response = new Response(null, { status: 307, headers: { Location: "https://finite.example/app" } });
  finishOAuthRedirect(response, "https://finite.example/auth/callback");
  assert.equal(response.headers.get("location"), "https://finite.example/onboarding");
});

test("app proxy wires OAuth exchange without opening admin or requiring public sign-in", async () => {
  const source = await readFile(new URL("../proxy.ts", import.meta.url), "utf8");
  assert.match(source, /!isAdmin && request.nextUrl.searchParams.has\("neon_auth_session_verifier"\)/);
  assert.match(source, /getAuth\(\).middleware\(\)\(request\)/);
  assert.match(source, /"\/auth\/callback"/);
  assert.match(source, /"\/login"/);
  assert.match(source, /if \(!isAdmin\) \{\s*return NextResponse.next\(\)/);
});
