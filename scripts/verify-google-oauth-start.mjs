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

function hasSafeGoogleOrigin(url) {
  return url.protocol === "https:" && url.hostname === GOOGLE_HOST && url.port === "" && url.username === "" && url.password === "";
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

export async function verifyGoogleOAuthStart({ startPayload, expectedCallback, fetchImpl = fetch }) {
  let payload;
  try {
    payload = typeof startPayload === "string" ? JSON.parse(startPayload) : startPayload;
  } catch {
    throw new Error("The deployed auth endpoint did not return valid JSON.");
  }

  let authorizationUrl;
  let callbackUrl;
  try {
    authorizationUrl = new URL(payload?.url);
    callbackUrl = new URL(authorizationUrl.searchParams.get("redirect_uri"));
  } catch {
    throw new Error("The deployed auth endpoint did not return a valid Google authorization URL.");
  }

  if (
    !hasSafeGoogleOrigin(authorizationUrl) ||
    !GOOGLE_AUTH_PATHS.has(authorizationUrl.pathname)
  ) {
    throw new Error("The deployed auth endpoint returned an unexpected OAuth provider URL.");
  }
  if (callbackUrl.href !== expectedCallback) {
    throw new Error(`The deployed Google callback does not match the preview Neon Auth branch. Expected: ${expectedCallback}`);
  }

  const response = await fetchImpl(authorizationUrl, {
    redirect: "manual",
    headers: { "user-agent": "finite-feed-preview-oauth-smoke/1.0" },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.text();
  const locationValue = response.headers.get("location");
  let locationUrl = null;
  if (locationValue) {
    try {
      locationUrl = new URL(locationValue, authorizationUrl);
    } catch {
      throw new Error("Google returned an invalid redirect while starting OAuth.");
    }
  }

  if (
    containsRedirectMismatch(body) ||
    containsRedirectMismatch(locationValue) ||
    containsRedirectMismatch(decodedAuthError(locationUrl))
  ) {
    throw registrationError(expectedCallback);
  }
  if (locationUrl?.pathname === "/signin/oauth/error") {
    throw new Error("Google redirected the authorization request to its OAuth error page.");
  }
  if (response.status >= 400) {
    throw new Error(`Google rejected the OAuth authorization request with HTTP ${response.status}.`);
  }
  if (
    response.status < 300 ||
    response.status >= 400 ||
    !locationUrl ||
    !hasSafeGoogleOrigin(locationUrl) ||
    !GOOGLE_LOGIN_PATHS.some((pattern) => pattern.test(locationUrl.pathname))
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
