import { expect, test } from "@playwright/test";

test("preview credentials expose no preset and handle provider failure before isolated signup", async ({ page }) => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  await page.route("**/api/auth/sign-in/email", async (route) => {
    calls.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    await route.fulfill({ status: 401, json: { message: "Invalid email or password" } });
  });
  await page.route("**/api/auth/sign-up/email", async (route) => {
    calls.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    await route.fulfill({ json: {
      token: "isolated-preview-token",
      user: { id: "preview-user", name: "Preview tester", email: "developer@example.test", emailVerified: false },
    } });
  });
  await page.route("**/api/personal/account", (route) => route.fulfill({ json: { onboarding_completed: false } }));
  await page.route("**/api/personal/onboarding", (route) => route.fulfill({ json: {
    status: "not_started", current_step: "question_1", questions: [], answers: {}, open_response: null,
    draft_profile: null, delivery: null, telegram_connected: false,
  } }));

  await page.goto("/login");
  await page.getByText("Developer preview access").click();
  const email = page.getByLabel("Email");
  const password = page.getByLabel("Password");
  await expect(email).toHaveValue("");
  await expect(password).toHaveValue("");
  await email.fill("developer@example.test");
  await password.fill("unique-preview-password");

  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator(".signal-error[role='alert']")).toHaveText("Preview sign-in failed. Check the email and password, then try again.");
  await page.getByRole("button", { name: "Create preview account" }).click();
  await page.waitForURL("**/onboarding");

  expect(calls).toEqual([
    { path: "/api/auth/sign-in/email", body: { email: "developer@example.test", password: "unique-preview-password" } },
    { path: "/api/auth/sign-up/email", body: { email: "developer@example.test", password: "unique-preview-password", name: "Preview tester" } },
  ]);
});
