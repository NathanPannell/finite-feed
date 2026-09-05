import assert from "node:assert/strict";
import test from "node:test";

import {
  matchApiBaseUrl,
  proxyMatchRequest,
  reviewerCookieHeader,
  rewriteReviewerSetCookie,
} from "../app/api/match/annotations/match-proxy.ts";

const apiBaseUrl = "https://api.finite-feed.test";
const reviewerCookie = "finite_feed_match_reviewer=v1.reviewer.signature";

test("uses the server-only Railway runtime API base URL", () => {
  assert.equal(matchApiBaseUrl({ RAILWAY_API_BASE_URL: apiBaseUrl }), apiBaseUrl);
  assert.equal(matchApiBaseUrl({ NEXT_PUBLIC_API_BASE_URL: "https://public.example" }), undefined);
});

test("persists only the reviewer cookie and reuses it through the full match flow", async () => {
  const calls = [];
  let saved = false;
  const fetcher = async (input, init) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    calls.push({ url: url.href, init, cookie: headers.get("cookie") });

    if (url.pathname === "/api/annotations/next") {
      return Response.json(saved ? null : { profile_id: "p1", video_id: "v1" }, {
        headers: saved ? undefined : {
          "Set-Cookie": `${reviewerCookie}; Max-Age=63072000; Path=/api/annotations; Domain=api.finite-feed.test; HttpOnly; Secure; SameSite=None`,
        },
      });
    }
    if (url.pathname === "/api/annotations/stats") {
      return Response.json({ completed: saved ? 1 : 0, remaining: saved ? 0 : 1 });
    }
    assert.equal(url.pathname, "/api/annotations");
    assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(init.body), {
      profile_id: "p1",
      video_id: "v1",
      label: "yes",
      rationale: null,
    });
    saved = true;
    return Response.json({ saved: true });
  };

  const first = await proxyMatchRequest(
    new Request("https://finite-feed.test/api/match/annotations/next"),
    ["next"],
    apiBaseUrl,
    fetcher,
  );
  assert.equal(calls[0].cookie, null);
  assert.deepEqual(await first.json(), { profile_id: "p1", video_id: "v1" });
  const setCookie = first.headers.get("set-cookie");
  assert.match(setCookie, /^finite_feed_match_reviewer=v1\.reviewer\.signature;/);
  assert.match(setCookie, /Max-Age=63072000/);
  assert.match(setCookie, /Path=\/api\/match\/annotations/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.doesNotMatch(setCookie, /Domain=/i);
  assert.doesNotMatch(setCookie, /SameSite=None/i);

  const browserCookies = `session=do-not-forward; ${reviewerCookie}; xsrf=also-private`;
  await proxyMatchRequest(
    new Request("https://finite-feed.test/api/match/annotations/stats", {
      headers: { Cookie: browserCookies },
    }),
    ["stats"],
    apiBaseUrl,
    fetcher,
  );
  const submission = await proxyMatchRequest(
    new Request("https://finite-feed.test/api/match/annotations", {
      method: "POST",
      headers: { Cookie: browserCookies, "Content-Type": "application/json" },
      body: JSON.stringify({ profile_id: "p1", video_id: "v1", label: "yes", rationale: null }),
    }),
    [],
    apiBaseUrl,
    fetcher,
  );
  assert.equal(submission.status, 200);
  const repeated = await proxyMatchRequest(
    new Request("https://finite-feed.test/api/match/annotations/next", {
      headers: { Cookie: browserCookies },
    }),
    ["next"],
    apiBaseUrl,
    fetcher,
  );
  assert.equal(await repeated.json(), null, "a saved pair is excluded on the next request");

  assert.deepEqual(calls.map(({ url }) => new URL(url).pathname), [
    "/api/annotations/next",
    "/api/annotations/stats",
    "/api/annotations",
    "/api/annotations/next",
  ]);
  assert.deepEqual(calls.slice(1).map(({ cookie }) => cookie), [reviewerCookie, reviewerCookie, reviewerCookie]);
  assert.ok(calls.every(({ init }) => init.cache === "no-store" && init.redirect === "manual"));
});

test("cookie helpers reject ambiguity and rewrite only the reviewer cookie", () => {
  assert.equal(reviewerCookieHeader(`session=secret; ${reviewerCookie}`), reviewerCookie);
  assert.equal(reviewerCookieHeader(`${reviewerCookie}; ${reviewerCookie}`), null);
  assert.equal(reviewerCookieHeader("finite_feed_match_reviewer=unsafe%20value"), null);
  assert.equal(rewriteReviewerSetCookie("session=secret; Path=/; HttpOnly"), null);
  assert.equal(
    rewriteReviewerSetCookie(`${reviewerCookie}; Path=/api/annotations; Domain=evil.test; SameSite=None`),
    `${reviewerCookie}; Path=/api/match/annotations; HttpOnly; SameSite=Lax`,
  );
});

test("the proxy rejects unapproved routes, media types, and oversized bodies locally", async () => {
  let fetchCount = 0;
  const fetcher = async () => {
    fetchCount += 1;
    return Response.json({ unexpected: true });
  };

  const missing = await proxyMatchRequest(
    new Request("https://finite-feed.test/api/match/annotations/admin"),
    ["admin"],
    apiBaseUrl,
    fetcher,
  );
  assert.equal(missing.status, 404);

  const wrongType = await proxyMatchRequest(
    new Request("https://finite-feed.test/api/match/annotations", { method: "POST", body: "hello" }),
    [],
    apiBaseUrl,
    fetcher,
  );
  assert.equal(wrongType.status, 415);

  const oversized = await proxyMatchRequest(
    new Request("https://finite-feed.test/api/match/annotations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rationale: "x".repeat(4_096) }),
    }),
    [],
    apiBaseUrl,
    fetcher,
  );
  assert.equal(oversized.status, 413);
  assert.equal(fetchCount, 0);
});
