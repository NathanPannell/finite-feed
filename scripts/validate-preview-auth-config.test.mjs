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

test("preview deployment publishes and validates its branch callback without an auth-mode flag", () => {
  const workflow = readFileSync(new URL("../.github/workflows/preview.yml", import.meta.url), "utf8");
  assert.doesNotMatch(workflow, /DEVELOPER_PREVIEW_AUTH/);
  assert.match(workflow, /Google OAuth callback:/);
  assert.match(workflow, /validate-preview-auth-config\.mjs/);
});
