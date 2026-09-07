import assert from "node:assert/strict";
import test from "node:test";

const { loadHomepageFeatureFlags } = await import("../lib/public-feature-flags.ts");

test("homepage visibility uses the fresh runtime feature value", async () => {
  let requestUrl = "";
  let requestInit;
  const flags = await loadHomepageFeatureFlags("https://api.example", async (url, init) => {
    requestUrl = String(url);
    requestInit = init;
    return Response.json({ match_lab_homepage_visible: false });
  });

  assert.deepEqual(flags, { matchLabHomepageVisible: false });
  assert.equal(requestUrl, "https://api.example/api/features");
  assert.equal(requestInit.cache, "no-store");
});

test("homepage visibility preserves the current enabled behavior when config is unavailable", async () => {
  assert.deepEqual(await loadHomepageFeatureFlags(undefined), { matchLabHomepageVisible: true });
  assert.deepEqual(await loadHomepageFeatureFlags("https://api.example", async () => {
    throw new Error("offline");
  }), { matchLabHomepageVisible: true });
  assert.deepEqual(await loadHomepageFeatureFlags("https://api.example", async () => Response.json({})), {
    matchLabHomepageVisible: true,
  });
});
