import assert from "node:assert/strict";
import test from "node:test";

import { isVercelAuthLocation } from "./validate-vercel-auth-location.mjs";

test("accepts Vercel authentication locations", () => {
  assert.equal(isVercelAuthLocation("/_vercel/sso"), true);
  assert.equal(isVercelAuthLocation("https://vercel.com/sso?next=%2Fadmin"), true);
  assert.equal(isVercelAuthLocation("https://vercel.com/sso-api?url=%2Fadmin"), true);
  assert.equal(isVercelAuthLocation("https://auth.vercel.com/_vercel/sso"), true);
});

test("rejects lookalike and unrelated redirect locations", () => {
  assert.equal(isVercelAuthLocation("https://attacker.example/path.vercel.com/_vercel/sso"), false);
  assert.equal(isVercelAuthLocation("https://vercel.com.attacker.example/sso"), false);
  assert.equal(isVercelAuthLocation("http://vercel.com/sso"), false);
  assert.equal(isVercelAuthLocation("https://vercel.com/other"), false);
  assert.equal(isVercelAuthLocation("//vercel.com/sso"), false);
  assert.equal(isVercelAuthLocation(""), false);
});