import assert from "node:assert/strict";
import test from "node:test";
import { developerPreviewAuthEnabled, isDeveloperPasswordRoute } from "../lib/auth/developer-preview.ts";

test("developer password auth requires both the Vercel preview environment and explicit flag", () => {
  assert.equal(developerPreviewAuthEnabled({ VERCEL_ENV: "preview", DEVELOPER_PREVIEW_AUTH: "true" }), true);
  assert.equal(developerPreviewAuthEnabled({ VERCEL_ENV: "preview", DEVELOPER_PREVIEW_AUTH: "false" }), false);
  assert.equal(developerPreviewAuthEnabled({ VERCEL_ENV: "production", DEVELOPER_PREVIEW_AUTH: "true" }), false);
  assert.equal(developerPreviewAuthEnabled({ VERCEL_ENV: "development", DEVELOPER_PREVIEW_AUTH: "true" }), false);
});

test("the preview gate applies only to native password sign-in and sign-up", () => {
  assert.equal(isDeveloperPasswordRoute(["sign-in", "email"]), true);
  assert.equal(isDeveloperPasswordRoute(["sign-up", "email"]), true);
  assert.equal(isDeveloperPasswordRoute(["sign-in", "social"]), false);
  assert.equal(isDeveloperPasswordRoute(["get-session"]), false);
  assert.equal(isDeveloperPasswordRoute(["callback", "google"]), false);
});
