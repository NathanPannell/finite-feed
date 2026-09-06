import { expect, test } from "@playwright/test";

test("email credentials switch clearly from sign-in failure to account creation", async ({ page }) => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  await page.route("**/api/auth/sign-in/email", async (route) => {
    calls.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    await route.fulfill({ status: 401, json: { message: "Invalid email or password" } });
  });
  await page.route("**/api/auth/sign-up/email", async (route) => {
    calls.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    await route.fulfill({ json: {
      token: "new-account-token",
      user: { id: "new-user", name: "Ada Tester", email: "reader@example.test", emailVerified: false },
    } });
  });
  await page.route("**/api/personal/account", (route) => route.fulfill({ json: { onboarding_completed: false } }));
  await page.route("**/api/personal/onboarding", (route) => route.fulfill({ json: {
    status: "not_started", current_step: "question_1", questions: [], answers: {}, open_response: null,
    draft_profile: null, delivery: null, telegram_connected: false,
  } }));

  await page.goto("/login");
  const googleOption = await page.locator(".google-auth-option").boundingBox();
  const emailOption = await page.locator(".email-auth-option").boundingBox();
  expect(googleOption?.y).toBe(emailOption?.y);
  await expect(page.locator(".google-signin")).toHaveCSS("min-height", "52px");
  await expect(page.locator(".email-auth-submit")).toHaveCSS("min-height", "52px");
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileLayout = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, viewportHeight: innerHeight }));
  expect(mobileLayout.width).toBeLessThanOrEqual(390);
  expect(mobileLayout.height).toBeLessThanOrEqual(mobileLayout.viewportHeight * 1.75);
  const email = page.getByLabel("Email", { exact: true });
  const password = page.getByLabel("Password", { exact: true });
  await expect(email).toHaveValue("");
  await expect(password).toHaveValue("");
  await expect(password).toHaveAttribute("autocomplete", "current-password");
  await email.fill("reader@example.test");
  await password.fill("strong-test-password");

  await password.press("Enter");
  await expect(page.locator(".signal-error[role='alert']")).toHaveText("Sign-in failed. Check the email and password, then try again.");
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByLabel("Name")).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toHaveAttribute("autocomplete", "new-password");
  await page.getByLabel("Name").fill("Ada Tester");
  await page.getByLabel("Password", { exact: true }).fill("strong-test-password");
  await page.getByRole("button", { name: "Create account", exact: true }).last().click();
  await page.waitForURL("**/onboarding");

  expect(calls).toEqual([
    { path: "/api/auth/sign-in/email", body: { email: "reader@example.test", password: "strong-test-password" } },
    { path: "/api/auth/sign-up/email", body: { email: "reader@example.test", password: "strong-test-password", name: "Ada Tester" } },
  ]);
});
