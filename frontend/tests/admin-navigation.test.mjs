import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../components/signal-shell.tsx", import.meta.url), "utf8");

test("admin navigation uses full-document anchors for cross-origin SSO", () => {
  assert.doesNotMatch(source, /<Link[^>]+href="\/admin"/);
  assert.equal([...source.matchAll(/<a href="\/admin"/g)].length, 2);
});