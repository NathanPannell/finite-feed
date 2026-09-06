import assert from "node:assert/strict";
import test from "node:test";
import { verifyGoogleOAuthStart } from "./verify-google-oauth-start.mjs";

const callback = "https://preview-auth.example/app/auth/callback/google";

function payload(redirectUri = callback) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: "public-client-id.apps.googleusercontent.com",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: "opaque-state",
  });
  return JSON.stringify({ url: url.href, redirect: false });
}

test("accepts Google's sign-in redirect for the exact Neon callback", async () => {
  const result = await verifyGoogleOAuthStart({
    startPayload: payload(),
    expectedCallback: callback,
    fetchImpl: async () => new Response(null, {
      status: 302,
      headers: { location: "https://accounts.google.com/v3/signin/identifier?flowName=GeneralOAuthFlow" },
    }),
  });
  assert.deepEqual(result, { callback });
});

test("detects Google's redirect_uri_mismatch error page even when it returns HTTP 200", async () => {
  await assert.rejects(
    verifyGoogleOAuthStart({
      startPayload: payload(),
      expectedCallback: callback,
      fetchImpl: async () => new Response(
        "<html><body><h1>Error 400: redirect_uri_mismatch</h1></body></html>",
        { status: 200, headers: { "content-type": "text/html" } },
      ),
    }),
    new RegExp(`Register this exact authorized redirect URI.*${callback.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
});

test("detects Google's redirect to its OAuth error page", async () => {
  const authError = Buffer.from("redirect_uri_mismatch: You can't sign in to this app because it doesn't comply with Google's OAuth policy.").toString("base64url");
  await assert.rejects(
    verifyGoogleOAuthStart({
      startPayload: payload(),
      expectedCallback: callback,
      fetchImpl: async () => new Response(null, {
        status: 302,
        headers: { location: `https://accounts.google.com/signin/oauth/error?authError=${authError}` },
      }),
    }),
    /redirect_uri_mismatch/,
  );
});

test("does not mislabel an unrelated Google OAuth error as a callback mismatch", async () => {
  const authError = Buffer.from("invalid_client: The OAuth client was not found.").toString("base64url");
  await assert.rejects(
    verifyGoogleOAuthStart({
      startPayload: payload(),
      expectedCallback: callback,
      fetchImpl: async () => new Response(null, {
        status: 302,
        headers: { location: `https://accounts.google.com/signin/oauth/error?authError=${authError}` },
      }),
    }),
    (error) => error.message.includes("OAuth error page") && !error.message.includes("redirect_uri_mismatch"),
  );
});

test("rejects an authorization URL for the wrong Neon callback before contacting Google", async () => {
  let contactedGoogle = false;
  await assert.rejects(
    verifyGoogleOAuthStart({
      startPayload: payload("https://other-auth.example/app/auth/callback/google"),
      expectedCallback: callback,
      fetchImpl: async () => {
        contactedGoogle = true;
        return new Response();
      },
    }),
    /does not match the preview Neon Auth branch/,
  );
  assert.equal(contactedGoogle, false);
});

test("fails closed on an unknown Google redirect", async () => {
  await assert.rejects(
    verifyGoogleOAuthStart({
      startPayload: payload(),
      expectedCallback: callback,
      fetchImpl: async () => new Response(null, {
        status: 302,
        headers: { location: "https://accounts.google.com/challenge/unknown" },
      }),
    }),
    /unexpected response instead of its sign-in prompt/,
  );
});

test("rejects Google lookalike URLs with credentials or unexpected ports", async () => {
  for (const providerUrl of [
    "https://attacker@accounts.google.com/o/oauth2/v2/auth",
    "https://accounts.google.com:444/o/oauth2/v2/auth",
  ]) {
    const url = new URL(providerUrl);
    url.searchParams.set("redirect_uri", callback);
    await assert.rejects(
      verifyGoogleOAuthStart({
        startPayload: { url: url.href },
        expectedCallback: callback,
        fetchImpl: async () => assert.fail("unsafe provider URL must not be fetched"),
      }),
      /unexpected OAuth provider URL/,
    );
  }
});

test("fails closed on a denied Google response without a mismatch marker", async () => {
  await assert.rejects(
    verifyGoogleOAuthStart({
      startPayload: payload(),
      expectedCallback: callback,
      fetchImpl: async () => new Response("request denied", { status: 403 }),
    }),
    /HTTP 403/,
  );
});
