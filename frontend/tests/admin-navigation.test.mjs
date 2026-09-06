import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../components/site-chrome.tsx", import.meta.url), "utf8");
const proxySource = await readFile(new URL("../app/api/admin/[...path]/route.ts", import.meta.url), "utf8");

test("admin navigation uses full-document anchors for cross-origin SSO", () => {
  assert.doesNotMatch(source, /<Link[^>]+href="\/admin"/);
  assert.equal([...source.matchAll(/<a href="\/admin"/g)].length, 1);
  assert.equal([...source.matchAll(/<PrimaryLinks active=/g)].length, 2);
});

test("admin proxy allows every dashboard overview request", () => {
  for (const route of ["summary", "activity", "performance"]) {
    assert.match(proxySource, new RegExp(`\\["${route}", new Set\\(\\["GET"\\]\\)\\]`));
  }
});
