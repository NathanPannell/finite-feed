import assert from "node:assert/strict";
import test from "node:test";

import { appVersionLabel } from "../lib/app-version.ts";

const commit = "abcdef0123456789abcdef0123456789abcdef01";

test("production displays the released version and short deployed commit", () => {
  assert.equal(appVersionLabel({ version: "0.1.0", environment: "production", commit }), "v0.1.0 · abcdef0");
});

test("staging distinguishes its prospective version and exact build source", () => {
  assert.equal(appVersionLabel({ version: "0.2.0", environment: "staging", commit }), "Next v0.2.0 · staging/abcdef0");
});

test("an unconfigured local checkout has a safe label", () => {
  assert.equal(appVersionLabel({ version: "dev", environment: "local", commit: "working-tree" }), "Local build");
});
