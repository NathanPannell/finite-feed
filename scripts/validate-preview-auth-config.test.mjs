import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { validatePreviewAuthConfig } from "./validate-preview-auth-config.mjs";

const previewAuth = "https://preview-branch.neonauth.example/app/auth";
const parentAuth = "https://production.neonauth.example/app/auth";

test("derives the branch callback and requires the exact Vercel preview origin", () => {
  const result = validatePreviewAuthConfig({
    previewAuthBaseUrl: previewAuth,
    parentAuthBaseUrl: parentAuth,
    previewFrontendUrl: "https://finite-feed-pr-40.vercel.app",
    trustedDomains: { domains: [{ domain: "https://finite-feed-pr-40.vercel.app" }] },
  });
  assert.equal(result.callbackUrl, `${previewAuth}/callback/google`);
  assert.equal(result.previewFrontendOrigin, "https://finite-feed-pr-40.vercel.app");
});

test("Google callback stays stable when the Vercel deployment URL changes", () => {
  const first = validatePreviewAuthConfig({
    previewAuthBaseUrl: previewAuth,
    parentAuthBaseUrl: parentAuth,
    previewFrontendUrl: "https://finite-feed-first.vercel.app",
  });
  const second = validatePreviewAuthConfig({
    previewAuthBaseUrl: previewAuth,
    parentAuthBaseUrl: parentAuth,
    previewFrontendUrl: "https://finite-feed-second.vercel.app",
  });
  assert.equal(first.callbackUrl, second.callbackUrl);
});

test("rejects production auth fallback and an untrusted current preview", () => {
  assert.throws(() => validatePreviewAuthConfig({
    previewAuthBaseUrl: parentAuth,
    parentAuthBaseUrl: parentAuth,
  }), /branch-specific origin/);
  assert.throws(() => validatePreviewAuthConfig({
    previewAuthBaseUrl: previewAuth,
    parentAuthBaseUrl: parentAuth,
    previewFrontendUrl: "https://finite-feed-current.vercel.app",
    trustedDomains: ["https://finite-feed-old.vercel.app"],
  }), /not trusted/);
});

test("rejects non-preview and unsafe URLs", () => {
  assert.throws(() => validatePreviewAuthConfig({
    previewAuthBaseUrl: "http://preview.neonauth.example/auth",
    parentAuthBaseUrl: parentAuth,
  }), /HTTPS/);
  assert.throws(() => validatePreviewAuthConfig({
    previewAuthBaseUrl: previewAuth,
    parentAuthBaseUrl: parentAuth,
    previewFrontendUrl: "https://finite-feed.example.com",
  }), /Vercel preview/);
});

test("preview skips Google OAuth while production and native preview authentication remain covered", () => {
  const previewWorkflow = readFileSync(new URL("../.github/workflows/preview.yml", import.meta.url), "utf8");
  const productionWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.doesNotMatch(previewWorkflow, /verify-google-oauth-start\.mjs/);
  assert.doesNotMatch(previewWorkflow, /GOOGLE_OAUTH_CALLBACK/);
  assert.match(previewWorkflow, /smoke-preview-native-auth\.py --preview-url "\$FRONTEND_URL" --auth-only/);
  assert.match(previewWorkflow, /Google OAuth is optional for previews and is not a readiness check/);
  assert.match(productionWorkflow, /Verify Google OAuth accepts the production callback/);
  assert.match(productionWorkflow, /verify-google-oauth-start\.mjs/);
  assert.match(previewWorkflow, /validate-preview-auth-config\.mjs/);
});
