import { expect, test } from "@playwright/test";

const canonical = "https://finite-feed-rho.vercel.app/match";

test("Match Lab provides crawler metadata and a readable branded PNG", async ({ request, page }) => {
  const response = await request.get("/match", { headers: { "user-agent": "LinkedInBot/1.0" } });
  expect(response.ok()).toBeTruthy();
  const html = await response.text();
  expect(html).toContain(`rel="canonical" href="${canonical}"`);
  expect(html).toContain('property="og:title" content="Match Lab');
  expect(html).toContain('property="og:description" content="Compare a synthetic viewer');
  expect(html).toContain(`property="og:image" content="${canonical}/share-image"`);
  expect(html).toContain('name="twitter:card" content="summary_large_image"');
  expect(html).toContain(`name="twitter:image" content="${canonical}/share-image"`);

  const image = await request.get("/match/share-image");
  expect(image.ok()).toBeTruthy();
  expect(image.headers()["content-type"]).toContain("image/png");
  const bytes = await image.body();
  expect(bytes.subarray(1, 4).toString()).toBe("PNG");
  expect(bytes.readUInt32BE(16)).toBe(1200);
  expect(bytes.readUInt32BE(20)).toBe(630);

  await page.goto("/match");
  await expect(page.getByRole("link", { name: "Review a match" })).toBeVisible();
  await expect(page.getByText("The pairs were selected by an AI assistant.", { exact: false })).toBeVisible();
  await expect(page.getByText(/Each review takes about a minute/)).toHaveCount(0);
});

for (const viewport of [{ width: 320, height: 800 }, { width: 390, height: 844 }, { width: 430, height: 932 }]) {
  test(`Match Lab introduction fits ${viewport.width}px with an initial CTA`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/match");
    const cta = page.getByRole("link", { name: "Review a match" });
    const box = await cta.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThan(viewport.height - 72);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  });
}
