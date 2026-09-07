import { expect, test } from "@playwright/test";

const port = process.env.PLAYWRIGHT_PORT ?? "3107";
const disabledHomepage = `http://127.0.0.1:${Number(port) + 3}`;

test("disabled Match Lab visibility removes home-page entry points but preserves direct access", async ({ page }) => {
  test.skip(Boolean(process.env.PLAYWRIGHT_BASE_URL), "The isolated disabled-flag server runs only in local and CI builds.");

  await page.goto(disabledHomepage);
  await expect(page.getByRole("link", { name: /Match Lab/i })).toHaveCount(0);

  const response = await page.goto(`${disabledHomepage}/match`);
  expect(response?.ok()).toBe(true);
  await expect(page.getByRole("heading", { name: "Does this video fit?" })).toBeVisible();
});
