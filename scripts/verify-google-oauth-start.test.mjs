import assert from "node:assert/strict";
import test from "node:test";
import { verifyGoogleOAuthStart } from "./verify-google-oauth-start.mjs";

const authBase = "https://preview-auth.example/app/auth";
const callback = `${authBase}/callback/google`;

function startPayload(url = `${authBase}/sign-in/social/init?token=opaque-broker-token`) {
  return JSON.stringify({ url, redirect: false });
}

function googleAuthorizationUrl(redirectUri = callback) {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: "public-client-id.apps.googleusercontent.com",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: "opaque-state",
  });
  return url.href;
}

function responseSequence(...responses) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url) => {
      calls.push(new URL(url).href);
      assert.ok(responses.length, "received an unexpected fetch");
      return responses.shift();
    },
  };
}

function brokerRedirect(googleUrl = googleAuthorizationUrl()) {
  return new Response(null, { status: 302, headers: { location: googleUrl } });
}

test("follows the deployed Neon broker response and accepts Google's sign-in redirect", async () => {
  const sequence = responseSequence(
    brokerRedirect(),
    new Response(null, {
      status: 302,
      headers: { location: "https://accounts.google.com/v3/signin/identifier?flowName=GeneralOAuthFlow" },
    }),
  );
  const result = await verifyGoogleOAuthStart({
    startPayload: startPayload(),
    expectedCallback: callback,
    fetchImpl: sequence.fetchImpl,
  });
  assert.deepEqual(result, { callback });
  assert.deepEqual(sequence.calls.map((url) => new URL(url).hostname), ["preview-auth.example", "accounts.google.com"]);
});

test("detects Google's redirect_uri_mismatch error page even when it returns HTTP 200", async () => {
  const sequence = responseSequence(
    brokerRedirect(),
    new Response("<html><body><h1>Error 400: redirect_uri_mismatch</h1></body></html>", { status: 200 }),
  );
  await assert.rejects(
    verifyGoogleOAuthStart({ startPayload: startPayload(), expectedCallback: callback, fetchImpl: sequence.fetchImpl }),
    new RegExp(`Register this exact authorized redirect URI.*${callback.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
});

test("detects Google's encoded redirect_uri_mismatch error redirect", async () => {
  const authError = Buffer.from("redirect_uri_mismatch: callback not registered").toString("base64url");
  const sequence = responseSequence(
    brokerRedirect(),
    new Response(null, { status: 302, headers: { location: `https://accounts.google.com/signin/oauth/error?authError=${authError}` } }),
  );
  await assert.rejects(
    verifyGoogleOAuthStart({ startPayload: startPayload(), expectedCallback: callback, fetchImpl: sequence.fetchImpl }),
    /redirect_uri_mismatch/,
  );
});

test("does not mislabel an unrelated Google OAuth error as a callback mismatch", async () => {
  const authError = Buffer.from("invalid_client: OAuth client not found").toString("base64url");
  const sequence = responseSequence(
    brokerRedirect(),
    new Response(null, { status: 302, headers: { location: `https://accounts.google.com/signin/oauth/error?authError=${authError}` } }),
  );
  await assert.rejects(
    verifyGoogleOAuthStart({ startPayload: startPayload(), expectedCallback: callback, fetchImpl: sequence.fetchImpl }),
    (error) => error.message.includes("OAuth error page") && !error.message.includes("redirect_uri_mismatch"),
  );
});

test("rejects a Google authorization redirect for the wrong Neon callback", async () => {
  const sequence = responseSequence(brokerRedirect(googleAuthorizationUrl("https://other-auth.example/callback/google")));
  await assert.rejects(
    verifyGoogleOAuthStart({ startPayload: startPayload(), expectedCallback: callback, fetchImpl: sequence.fetchImpl }),
    /does not match the preview Neon Auth branch/,
  );
  assert.equal(sequence.calls.length, 1, "Google must not be contacted after callback drift");
});

test("rejects a broker URL outside the expected Neon Auth branch", async () => {
  for (const brokerUrl of [
    "https://other-auth.example/app/auth/sign-in/social/init?token=opaque",
    "https://attacker@preview-auth.example/app/auth/sign-in/social/init?token=opaque",
    "https://preview-auth.example:444/app/auth/sign-in/social/init?token=opaque",
    `${authBase}/sign-in/social/init?other=opaque`,
  ]) {
    await assert.rejects(
      verifyGoogleOAuthStart({
        startPayload: startPayload(brokerUrl),
        expectedCallback: callback,
        fetchImpl: async () => assert.fail("unsafe broker URL must not be fetched"),
      }),
      /unexpected Neon OAuth broker URL/,
    );
  }
});

test("rejects Google lookalike redirects from the Neon broker", async () => {
  for (const providerUrl of [
    "https://attacker@accounts.google.com/o/oauth2/v2/auth",
    "https://accounts.google.com:444/o/oauth2/v2/auth",
    "https://accounts.google.example/o/oauth2/v2/auth",
  ]) {
    const url = new URL(providerUrl);
    url.searchParams.set("redirect_uri", callback);
    const sequence = responseSequence(brokerRedirect(url.href));
    await assert.rejects(
      verifyGoogleOAuthStart({ startPayload: startPayload(), expectedCallback: callback, fetchImpl: sequence.fetchImpl }),
      /unexpected Google authorization redirect/,
    );
    assert.equal(sequence.calls.length, 1);
  }
});

test("fails closed when Neon does not redirect to Google", async () => {
  const sequence = responseSequence(new Response("provider unavailable", { status: 503 }));
  await assert.rejects(
    verifyGoogleOAuthStart({ startPayload: startPayload(), expectedCallback: callback, fetchImpl: sequence.fetchImpl }),
    /Neon Auth did not redirect.*HTTP 503/,
  );
});

test("fails closed on an unknown Google redirect", async () => {
  const sequence = responseSequence(
    brokerRedirect(),
    new Response(null, { status: 302, headers: { location: "https://accounts.google.com/challenge/unknown" } }),
  );
  await assert.rejects(
    verifyGoogleOAuthStart({ startPayload: startPayload(), expectedCallback: callback, fetchImpl: sequence.fetchImpl }),
    /unexpected response instead of its sign-in prompt/,
  );
});

test("fails closed on a denied Google response without a mismatch marker", async () => {
  const sequence = responseSequence(brokerRedirect(), new Response("request denied", { status: 403 }));
  await assert.rejects(
    verifyGoogleOAuthStart({ startPayload: startPayload(), expectedCallback: callback, fetchImpl: sequence.fetchImpl }),
    /HTTP 403/,
  );
});
