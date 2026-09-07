import { expect, Page, test } from "@playwright/test";

async function fixtures(page: Page, failure = false) {
  await page.route("**/api/personal/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/account")) return route.fulfill({ json: { onboarding_completed: true } });
    if (failure) return route.fulfill({ status: 503, json: { detail: "Unavailable" } });
    if (path.endsWith("/profile")) return route.fulfill({ json: { preference_statement: "Science", timezone: "UTC", cadence_days: [1], delivery_hour: 9, recommendation_count: 1, version: 1 } });
    return route.fulfill({ json: [] });
  });
  await page.route("**/api/admin/**", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/match/annotations/**", (route) => route.fulfill({ json: null }));
}

for (const width of [390, 1280]) {
  test(`shared routes skip repeated navigation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await fixtures(page);
    for (const path of ["/login", "/privacy", "/match", "/match/review", "/app", "/settings", "/admin"]) {
      await page.goto(path);
      const skip = page.getByRole("link", { name: "Skip to content", exact: true });
      await expect(skip).toHaveCount(1);
      await page.keyboard.press("Tab");
      await expect(skip).toBeFocused();
      await expect(skip).toBeInViewport();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("main")).toBeFocused();
      await expect(page).toHaveURL(/#main$/);
    }
  });
}

test("failed account data retains a working skip destination", async ({ page }) => {
  await fixtures(page, true);
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "We couldn’t load your feed." })).toBeVisible();
  await page.getByRole("link", { name: "Skip to content" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
});

test("homepage retains one skip link and settings uses its canonical route", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Skip to content" })).toHaveCount(1);
  await expect(page.getByRole("navigation", { name: "Primary navigation", exact: true }).getByRole("link", { name: "Settings", exact: true })).toHaveAttribute("href", "/settings");
  await page.getByRole("link", { name: "Support", exact: true }).click();
  await expect(page).toHaveURL(/\/privacy#help$/);
  await expect(page.getByRole("heading", { name: "Need help?" })).toBeInViewport();
  await expect(page.getByText(/If you have access to the project repository/)).toBeVisible();
});
