import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../proxy.ts", import.meta.url), "utf8");

test("admin proxy is scoped to private UI and API routes", () => {
  assert.match(source, /matcher:\s*\["\/admin\/:path\*", "\/api\/admin\/:path\*"\]/);
  assert.doesNotMatch(source, /matcher:[^\n]*\/match/);
});

test("production admin access redirects to the protected deployment host", () => {
  assert.match(source, /VERCEL_ENV !== "production"/);
  assert.match(source, /process\.env\.VERCEL_URL/);
  assert.match(source, /request\.nextUrl\.clone\(\)/);
  assert.match(source, /NextResponse\.redirect\(destination, 307\)/);
});

test("production fails closed when the generated deployment host is missing", () => {
  assert.match(source, /if \(!deploymentHost\)/);
  assert.match(source, /status: 503/);
});
