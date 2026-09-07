import { expect, test } from "@playwright/test";

async function mockSettings(page: import("@playwright/test").Page, memoryStatus = 200) {
  await page.route("**/api/personal/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const profile = { preference_statement: "Careful explanations of systems and decisions.", timezone: "America/Los_Angeles", cadence_days: [2, 5], delivery_hour: 9, recommendation_count: 1, version: 2, updated_at: "2026-09-06" };
    if (path === "/api/personal/account") return route.fulfill({ json: { id: "reader", email: "reader@example.test", display_name: "Reader", telegram_connected: true, delivery_paused: true } });
    if (path === "/api/personal/profile") return route.fulfill({ json: profile });
    if (path === "/api/personal/channels") return route.fulfill({ json: [{ id: "source-1", name: "A deliberately long source name that must wrap without clipping on a narrow screen", url: "https://youtube.com/@source", thumbnail_url: null, is_default: false }] });
    if (path === "/api/personal/profile/memory" && request.method() === "PUT") return route.fulfill({ status: memoryStatus, json: memoryStatus === 200 ? { ...profile, preference_statement: request.postDataJSON().preference_statement, version: 3 } : { detail: "Temporary failure" } });
    if (path === "/api/personal/account/preferences") return route.fulfill({ json: [] });
    return route.fulfill({ json: {} });
  });
}

test("puts routine settings before account controls and exposes compact section navigation", async ({ page }, testInfo) => {
  await mockSettings(page);
  await page.goto("/settings");
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  await expect(nav.getByRole("link", { name: "Delivery" })).toHaveAttribute("href", "#delivery");
  await expect(nav.getByRole("link", { name: "Interests" })).toHaveAttribute("href", "#interests");
  await expect(nav.getByRole("link", { name: "Sources" })).toHaveAttribute("href", "#sources");
  await expect(nav.getByRole("link", { name: "Account" })).toHaveAttribute("href", "#account");
  await expect(page.locator("#delivery").getByText("Telegram is connected. Delivery is paused.", { exact: false })).toBeVisible();
  const delivery = await page.locator("#delivery").boundingBox();
  const account = await page.locator("#account").boundingBox();
  expect(delivery?.y).toBeLessThan(account?.y ?? 0);
  await testInfo.attach("settings-desktop", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
});

test("keeps an interest draft visible when its save fails", async ({ page }) => {
  await mockSettings(page, 503);
  await page.goto("/settings");
  await page.getByRole("button", { name: "Edit interests" }).click();
  const input = page.getByLabel("Your interests and exclusions");
  await input.fill("Evidence first, with practical systems thinking.");
  await page.getByRole("button", { name: "Save interests" }).click();
  await expect(page.getByText("Could not save your interests", { exact: false })).toBeVisible();
  await expect(input).toHaveValue("Evidence first, with practical systems thinking.");
});

test("keeps an invalid timezone in place and explains how to correct it", async ({ page }) => {
  await mockSettings(page);
  await page.goto("/settings");
  const timezone = page.getByLabel("Timezone");
  await timezone.fill("Pacific time");
  await page.getByRole("button", { name: "Save delivery preferences" }).click();
  await expect(timezone).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Enter an IANA timezone such as America/Los_Angeles.", { exact: true })).toBeVisible();
  await expect(timezone).toHaveValue("Pacific time");
});

test("keeps settings controls and long source names inside a 320px viewport", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await mockSettings(page);
  await page.goto("/settings");
  await expect(page.getByRole("navigation", { name: "Settings sections" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit interests" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await testInfo.attach("settings-mobile-320", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
});

test("requires a named confirmation before removing a source", async ({ page }) => {
  await mockSettings(page);
  await page.goto("/settings");
  const remove = page.getByRole("button", { name: /Remove A deliberately long source name/ });
  await remove.click();
  const confirmation = page.getByRole("group", { name: /Confirm removal/ });
  await expect(confirmation).toContainText("You can add it again later.");
  await expect(confirmation.getByRole("button", { name: "Cancel" })).toBeFocused();
  await confirmation.getByRole("button", { name: "Cancel" }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(remove).toBeFocused();
});

test("saving one section preserves the other draft and serializes pending edits", async ({ page }) => {
  await mockSettings(page);
  let finishDelivery: () => void = () => {};
  const pendingDelivery = new Promise<void>((resolve) => { finishDelivery = resolve; });
  await page.route("**/api/personal/profile/delivery", async (route) => {
    await pendingDelivery;
    await route.fulfill({ json: { ...route.request().postDataJSON(), preference_statement: "Already saved interests", version: 4 } });
  });
  await page.goto("/settings");
  await page.getByLabel("Timezone").fill("Europe/London");
  await page.getByRole("button", { name: "Edit interests" }).click();
  const interests = page.getByLabel("Your interests and exclusions");
  await interests.fill("Practical science without hype.");
  await page.getByRole("button", { name: "Save interests", exact: true }).click();
  await expect(page.getByText("Your interests were saved.")).toBeVisible();
  await expect(page.getByLabel("Timezone")).toHaveValue("Europe/London");
  await page.getByRole("button", { name: "Edit interests" }).click();
  await interests.fill("This newer interest draft is not saved yet.");
  await page.getByRole("button", { name: "Save delivery preferences" }).click();
  await expect(page.getByLabel("Timezone")).toBeDisabled();
  await expect(page.getByLabel("Delivery hour (local time)")).toBeDisabled();
  await expect(interests).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save interests", exact: true })).toBeDisabled();
  finishDelivery();
  await expect(interests).toBeEnabled();
  await expect(interests).toHaveValue("This newer interest draft is not saved yet.");
  await expect(page.getByLabel("Timezone")).toHaveValue("Europe/London");
});
