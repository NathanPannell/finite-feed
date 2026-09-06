import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const GOOGLE_HOST = "accounts.google.com";
const GOOGLE_AUTH_PATHS = new Set(["/o/oauth2/auth", "/o/oauth2/v2/auth"]);
const GOOGLE_LOGIN_PATHS = [
  /^\/v\d+\/signin\/identifier\/?$/,
  /^\/signin\/v\d+\/identifier\/?$/,
  /^\/AccountChooser\/?$/,
  /^\/o\/oauth2\/auth\/oauthchooseaccount\/?$/,
];

function registrationError(expectedCallback) {
  return new Error(
    `Google rejected the preview OAuth callback with redirect_uri_mismatch. Register this exact authorized redirect URI in the existing Google web OAuth client, then rerun the workflow: ${expectedCallback}`,
  );
}

function containsRedirectMismatch(value) {
  return typeof value === "string" && /redirect_uri_mismatch/i.test(value);
}

function hasSafeHttpsOrigin(url) {
  return url.protocol === "https:" && url.port === "" && url.username === "" && url.password === "";
}

function hasSafeGoogleOrigin(url) {
  return hasSafeHttpsOrigin(url) && url.hostname === GOOGLE_HOST;
}

function decodedAuthError(locationUrl) {
  const encoded = locationUrl?.searchParams.get("authError");
  if (!encoded) return "";
  try {
    return Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

async function fetchWithoutRedirect(fetchImpl, url) {
  return fetchImpl(url, {
    redirect: "manual",
    headers: { "user-agent": "finite-feed-preview-oauth-smoke/1.0" },
    signal: AbortSignal.timeout(15_000),
  });
}

function redirectLocation(response, requestUrl, source) {
  const value = response.headers.get("location");
  if (!value) return { value: "", url: null };
  try {
    return { value, url: new URL(value, requestUrl) };
  } catch {
    throw new Error(`${source} returned an invalid redirect while starting OAuth.`);
  }
}

export async function verifyGoogleOAuthStart({ startPayload, expectedCallback, fetchImpl = fetch }) {
  let payload;
  try {
    payload = typeof startPayload === "string" ? JSON.parse(startPayload) : startPayload;
  } catch {
    throw new Error("The deployed auth endpoint did not return valid JSON.");
  }

  let expectedCallbackUrl;
  try {
    expectedCallbackUrl = new URL(expectedCallback);
  } catch {
    throw new Error("The expected Neon Auth callback is invalid.");
  }
  const callbackSuffix = "/callback/google";
  if (
    !hasSafeHttpsOrigin(expectedCallbackUrl) ||
    expectedCallbackUrl.search ||
    expectedCallbackUrl.hash ||
    !expectedCallbackUrl.pathname.endsWith(callbackSuffix)
  ) {
    throw new Error("The expected Neon Auth callback is invalid.");
  }
  const authBasePath = expectedCallbackUrl.pathname.slice(0, -callbackSuffix.length);

  let brokerUrl;
  try {
    brokerUrl = new URL(payload?.url);
  } catch {
    throw new Error("The deployed auth endpoint did not return a valid Neon OAuth broker URL.");
  }
  if (
    payload?.redirect !== false ||
    !hasSafeHttpsOrigin(brokerUrl) ||
    brokerUrl.origin !== expectedCallbackUrl.origin ||
    brokerUrl.pathname !== `${authBasePath}/sign-in/social/init` ||
    !brokerUrl.searchParams.get("token") ||
    brokerUrl.hash ||
    [...brokerUrl.searchParams.keys()].some((key) => key !== "token")
  ) {
    throw new Error("The deployed auth endpoint returned an unexpected Neon OAuth broker URL.");
  }

  const brokerResponse = await fetchWithoutRedirect(fetchImpl, brokerUrl);
  const brokerBody = await brokerResponse.text();
  const brokerLocation = redirectLocation(brokerResponse, brokerUrl, "Neon Auth");
  if (brokerResponse.status < 300 || brokerResponse.status >= 400 || !brokerLocation.url) {
    throw new Error(`Neon Auth did not redirect the OAuth request to Google (HTTP ${brokerResponse.status}).`);
  }
  if (containsRedirectMismatch(brokerBody) || containsRedirectMismatch(brokerLocation.value)) {
    throw registrationError(expectedCallbackUrl.href);
  }

  const authorizationUrl = brokerLocation.url;
  if (!hasSafeGoogleOrigin(authorizationUrl) || !GOOGLE_AUTH_PATHS.has(authorizationUrl.pathname)) {
    throw new Error("Neon Auth returned an unexpected Google authorization redirect.");
  }

  let callbackUrl;
  try {
    callbackUrl = new URL(authorizationUrl.searchParams.get("redirect_uri"));
  } catch {
    throw new Error("Google's authorization request did not contain a valid callback URL.");
  }
  if (callbackUrl.href !== expectedCallbackUrl.href) {
    throw new Error(`The deployed Google callback does not match the preview Neon Auth branch. Expected: ${expectedCallbackUrl.href}`);
  }

  const googleResponse = await fetchWithoutRedirect(fetchImpl, authorizationUrl);
  const googleBody = await googleResponse.text();
  const googleLocation = redirectLocation(googleResponse, authorizationUrl, "Google");
  if (
    containsRedirectMismatch(googleBody) ||
    containsRedirectMismatch(googleLocation.value) ||
    containsRedirectMismatch(decodedAuthError(googleLocation.url))
  ) {
    throw registrationError(expectedCallbackUrl.href);
  }
  if (googleLocation.url?.pathname === "/signin/oauth/error") {
    throw new Error("Google redirected the authorization request to its OAuth error page.");
  }
  if (googleResponse.status >= 400) {
    throw new Error(`Google rejected the OAuth authorization request with HTTP ${googleResponse.status}.`);
  }
  if (
    googleResponse.status < 300 ||
    googleResponse.status >= 400 ||
    !googleLocation.url ||
    !hasSafeGoogleOrigin(googleLocation.url) ||
    !GOOGLE_LOGIN_PATHS.some((pattern) => pattern.test(googleLocation.url.pathname))
  ) {
    throw new Error("Google returned an unexpected response instead of its sign-in prompt.");
  }

  return { callback: callbackUrl.href };
}

async function main() {
  const payloadFlag = process.argv.indexOf("--payload-file");
  const callbackFlag = process.argv.indexOf("--expected-callback");
  const payloadPath = payloadFlag >= 0 ? process.argv[payloadFlag + 1] : "";
  const expectedCallback = callbackFlag >= 0 ? process.argv[callbackFlag + 1] : "";
  if (!payloadPath || !expectedCallback) {
    throw new Error("Usage: verify-google-oauth-start.mjs --payload-file PATH --expected-callback URL");
  }

  const result = await verifyGoogleOAuthStart({
    startPayload: await readFile(payloadPath, "utf8"),
    expectedCallback,
  });
  console.log(`Google accepted the preview OAuth callback: ${result.callback}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Google OAuth verification failed.");
    process.exitCode = 1;
  });
}
