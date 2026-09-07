import { expect, test } from "@playwright/test";

const canonical = "https://finite-feed-rho.vercel.app";
const isSettled = (element: Element) => {
  const style = getComputedStyle(element);
  const matrix = new DOMMatrixReadOnly(style.transform);
  return style.opacity === "1" && matrix.m41 === 0 && matrix.m42 === 0;
};

test("shows verified video picks and switches interests without personal API calls", async ({ page }) => {
  let personalRequests = 0;
  await page.route("**/api/personal/**", (route) => {
    personalRequests += 1;
    return route.fulfill({ status: 500, json: { detail: "Unexpected request" } });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "The Creative Genius of Sneaker Design" })).toBeVisible();
  await expect(page.getByText("TED · Salehe Bembury and Cloe Shasha Brooks")).toBeVisible();
  await expect(page.getByRole("link", { name: "Watch on YouTube" })).toHaveAttribute("href", "https://www.youtube.com/watch?v=E-Se-_A4o-Y");

  await page.getByRole("button", { name: "Everyday behavior" }).click();
  await expect(page.getByRole("heading", { name: "What Sitting All Day Does to Your Brain and Body" })).toBeVisible();
  await expect(page.getByText("Keith Diaz explains how short movement breaks can interrupt long stretches of sitting.")).toBeVisible();

  await page.getByRole("button", { name: "Technology + media" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "How AI Is Breaking the Internet (and What to Do About It)" })).toBeVisible();
  await expect(page.getByText("Matthew Prince explains what AI means for online publishers and how creators could be paid for their work.")).toBeVisible();
  await expect(page.locator("[aria-live='polite']")).toContainText("Technology, media, and the open web");
  expect(personalRequests).toBe(0);
});

test("runs the finite sequence once and replay restarts it", async ({ page }) => {
  await page.goto("/");
  const finalStep = page.locator(".showcase-sequence span").last();
  await finalStep.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  await expect.poll(() => finalStep.evaluate(isSettled)).toBe(true);
  await page.getByRole("button", { name: "Replay" }).click();
  const replayedStep = page.locator(".showcase-sequence span").last();
  await expect.poll(() => replayedStep.evaluate((element) => element.getAnimations().some((animation) => animation.playState === "running"))).toBe(true);
  await replayedStep.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  expect(await replayedStep.evaluate(isSettled)).toBe(true);
});

test("settles immediately for reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const finalStep = page.locator(".showcase-sequence span").last();
  expect(await finalStep.evaluate(isSettled)).toBe(true);
  await expect(page.getByRole("heading", { name: "The Creative Genius of Sneaker Design" })).toBeVisible();
});

test("keeps a labeled fallback when a video thumbnail fails", async ({ page }) => {
  await page.route("**/_next/image?*", (route) => route.abort());
  await page.goto("/");
  const fallback = page.locator(".showcase-thumbnail-fallback");
  await expect(fallback).toContainText("TED");
  await expect(fallback).toContainText("14:00");
  await expect(fallback).toHaveAttribute("aria-label", "Watch The Creative Genius of Sneaker Design on YouTube");
});

test("removes provisional labels from public account surfaces", async ({ page }) => {
  for (const route of ["/", "/login", "/privacy"]) {
    await page.goto(route);
    await expect(page.locator("body")).not.toContainText(/private beta|illustrative|sample recommendation|demo profile/i);
  }
});

test("shows the same build metadata published by the version artifact", async ({ page, request }) => {
  await page.goto("/");
  const response = await request.get("/api/version");
  expect(response.ok()).toBe(true);
  const metadata = await response.json() as { version: string; environment: string; commit: string };
  await expect(page.locator(".site-footer-build")).toHaveAttribute("aria-label", `Build ${metadata.environment} ${metadata.version} commit ${metadata.commit}`);
});

test("keeps the real pick and primary action with JavaScript disabled", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your attention has better places to be." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "The Creative Genius of Sneaker Design" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Build my finite feed" }).first()).toBeVisible();
  await context.close();
});

for (const viewport of [{ width: 320, height: 800 }, { width: 390, height: 844 }, { width: 768, height: 900 }, { width: 1440, height: 1000 }]) {
  test(`keeps marketing navigation and content clear at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    const primary = page.getByRole("navigation", { name: "Primary navigation" });
    await expect(primary.getByRole("link", { name: "How it works" })).toBeVisible();
    await expect(primary.getByRole("link", { name: "Rate a match" })).toBeVisible();
    await expect(primary.getByRole("link", { name: "Build my feed" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("stacks the homepage showcase before the headline can overlap it", async ({ page }) => {
  await page.setViewportSize({ width: 985, height: 1000 });
  await page.goto("/");
  const geometry = await page.locator(".landing-hero").evaluate((hero) => {
    const headline = hero.querySelector("h1")?.getBoundingClientRect();
    const showcase = hero.querySelector(".showcase")?.getBoundingClientRect();
    return { headlineBottom: headline?.bottom ?? 0, showcaseTop: showcase?.top ?? 0 };
  });
  expect(geometry.showcaseTop).toBeGreaterThanOrEqual(geometry.headlineBottom);
});

test("publishes canonical social metadata and a 1200 by 630 PNG", async ({ request }) => {
  const response = await request.get("/", { headers: { "user-agent": "LinkedInBot/1.0" } });
  const html = await response.text();
  expect(html).toContain(`rel="canonical" href="${canonical}"`);
  expect(html).toContain(`property="og:image" content="${canonical}/share-image"`);
  expect(html).toContain('name="twitter:card" content="summary_large_image"');
  expect(html).toContain(`name="twitter:image" content="${canonical}/share-image"`);

  const image = await request.get("/share-image");
  expect(image.ok()).toBeTruthy();
  expect(image.headers()["content-type"]).toContain("image/png");
  const bytes = await image.body();
  expect(bytes.subarray(1, 4).toString()).toBe("PNG");
  expect(bytes.readUInt32BE(16)).toBe(1200);
  expect(bytes.readUInt32BE(20)).toBe(630);
});
