import { mkdir } from "node:fs/promises";
import { expect, Page, Route, test } from "@playwright/test";

type Delivery = { timezone: string; cadence_days: number[]; delivery_hour: number; recommendation_count: number };
type State = {
  status: "not_started" | "in_progress" | "completed";
  current_step: string;
  questions: typeof questions;
  answers: Record<string, string>;
  open_response: string | null;
  draft_profile: string | null;
  delivery: Delivery | null;
  telegram_connected: boolean;
};

const questions = [
  { id: 1, prompt: "What are you most interested in?", options: [
    { value: "technology_ai", label: "Technology & AI" }, { value: "business_work", label: "Business & work" },
    { value: "science_nature", label: "Science & nature" }, { value: "culture_society", label: "Culture & society" },
    { value: "mind_behavior", label: "Mind & behavior" }, { value: "health_wellbeing", label: "Health & wellbeing" },
  ] },
  { id: 2, prompt: "What do you want a good recommendation to give you?", options: [
    { value: "practical_skills", label: "Practical skills" }, { value: "fresh_perspectives", label: "Fresh perspectives" },
    { value: "deep_understanding", label: "Deeper understanding" }, { value: "inspiring_stories", label: "Inspiring stories" },
  ] },
  { id: 3, prompt: "How should it feel to watch?", options: [
    { value: "concise_focused", label: "Concise & focused" }, { value: "detailed_rigorous", label: "Detailed & rigorous" },
    { value: "surprising_provocative", label: "Surprising & provocative" }, { value: "accessible_conversational", label: "Accessible & conversational" },
  ] },
] as const;

const savedWords = "I want careful explanations of systems and decisions. I value evidence and want to avoid empty hype.";
const savedProfile = "You want careful explanations of systems and decisions. You prefer evidence and substance over hype.";
const rebuiltProfile = "You want practical business explanations grounded in evidence. You prefer concise guidance and want to avoid empty hype.";
const savedDelivery: Delivery = { timezone: "America/Los_Angeles", cadence_days: [2, 5], delivery_hour: 9, recommendation_count: 1 };

function stateAt(current_step: string): State {
  return {
    status: "in_progress",
    current_step,
    questions,
    answers: { "1": "technology_ai", "2": "deep_understanding", "3": "concise_focused" },
    open_response: savedWords,
    draft_profile: savedProfile,
    delivery: current_step === "telegram" ? { ...savedDelivery } : null,
    telegram_connected: false,
  };
}

function respond(route: Route, payload: unknown, status = 200) {
  return route.fulfill({ status, json: payload });
}

async function mockAccountShell(page: Page) {
  await page.route("**/api/personal/account", (route) => respond(route, { onboarding_completed: true }));
  await page.route("**/api/personal/profile", (route) => respond(route, { preference_statement: savedProfile, ...savedDelivery, version: 1, updated_at: "2026-09-06" }));
  await page.route("**/api/personal/channels", (route) => respond(route, []));
  await page.route("**/api/personal/recommendations", (route) => respond(route, []));
}

test("goes back without requests, hydrates drafts, and rebuilds after server invalidation", async ({ page }) => {
  const state = stateAt("telegram");
  const mutations: { path: string; body: Record<string, unknown> | null }[] = [];
  let synthesisCalls = 0;
  await page.route("**/api/personal/onboarding**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/personal/onboarding", "") || "/";
    const body = request.postData() ? request.postDataJSON() as Record<string, unknown> : null;
    if (request.method() === "GET") return respond(route, state);
    mutations.push({ path, body });
    if (path === "/answers" && body) {
      const question = Number(body.question);
      const answer = String(body.answer);
      if (state.answers[String(question)] !== answer) {
        state.answers[String(question)] = answer;
        for (let later = question + 1; later <= 3; later += 1) delete state.answers[String(later)];
        state.open_response = null;
        state.draft_profile = null;
        state.delivery = null;
      }
      state.current_step = question === 3 ? "open_response" : `question_${question + 1}`;
    } else if (path === "/open-response" && body) {
      state.open_response = String(body.response);
      state.draft_profile = null;
      state.delivery = null;
      state.current_step = "synthesize";
    } else if (path === "/synthesize") {
      synthesisCalls += 1;
      state.draft_profile = rebuiltProfile;
      state.current_step = "profile_review";
    }
    return respond(route, state);
  });

  await page.goto("/onboarding");
  await expect(page.getByLabel("Onboarding step 7 of 7: Telegram")).toBeVisible();
  await expect(page.getByLabel("Delivery, saved")).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("heading", { name: "Set a pace that feels useful." })).toBeFocused();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByText("This profile is already saved.")).toBeVisible();
  await page.getByRole("button", { name: "Edit" }).first().click();
  await expect(page.getByRole("radio", { name: "Technology & AI" })).toBeChecked();

  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("radio", { name: "Deeper understanding" })).toBeChecked();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("radio", { name: "Concise & focused" })).toBeChecked();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel("In your own words")).toHaveValue(savedWords);
  await page.getByRole("button", { name: "Build my profile" }).click();
  await expect(page.getByText(savedProfile)).toBeVisible();
  expect(mutations).toHaveLength(0);
  expect(synthesisCalls).toBe(0);

  await page.getByRole("button", { name: "Edit" }).first().click();
  await page.getByText("Business & work", { exact: true }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  expect(state.open_response).toBeNull();
  expect(state.draft_profile).toBeNull();
  expect(state.delivery).toBeNull();
  await expect(page.getByRole("radio", { name: "Deeper understanding" })).toBeChecked();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("radio", { name: "Concise & focused" })).toBeChecked();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByLabel("In your own words")).toHaveValue(savedWords);
  await page.getByRole("button", { name: "Build my profile" }).click();
  await expect(page.getByText(rebuiltProfile)).toBeVisible();
  await expect(page.getByText(savedProfile)).toHaveCount(0);
  expect(mutations.map(({ path }) => path)).toEqual(["/answers", "/answers", "/answers", "/open-response", "/synthesize"]);
  expect(synthesisCalls).toBe(1);
});

test("retains unsaved words through save and synthesis retries with inline validation", async ({ page }) => {
  const state = stateAt("synthesize");
  state.open_response = null;
  state.draft_profile = null;
  let openAttempts = 0;
  let synthesisAttempts = 0;
  await page.route("**/api/personal/onboarding**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/personal/onboarding", "") || "/";
    if (request.method() === "GET") return respond(route, state);
    if (path === "/open-response") {
      openAttempts += 1;
      if (openAttempts === 1) return respond(route, { detail: "Your words could not be saved. Try again." }, 503);
      state.open_response = String(request.postDataJSON().response);
      return respond(route, state);
    }
    if (path === "/synthesize") {
      synthesisAttempts += 1;
      if (synthesisAttempts === 1) return respond(route, { detail: "Profile writing is temporarily unavailable. Your answers are saved." }, 503);
      state.draft_profile = rebuiltProfile;
      state.current_step = "profile_review";
      return respond(route, state);
    }
    return respond(route, state);
  });

  await page.goto("/onboarding");
  const words = page.getByLabel("In your own words");
  await words.fill("   ");
  await page.getByRole("button", { name: "Build my profile" }).click();
  await expect(page.getByText("Enter a few sentences about what you want to watch.")).toBeVisible();
  await expect(words).toBeFocused();
  expect(openAttempts).toBe(0);

  const draft = "I want grounded explanations of real systems. Please avoid vague motivational content.";
  await words.fill(draft);
  await page.getByRole("button", { name: "Build my profile" }).click();
  await expect(page.locator(".onboarding-error")).toContainText("could not be saved");
  await expect(words).toHaveValue(draft);
  await page.getByRole("button", { name: "Build my profile" }).click();
  await expect(page.locator(".onboarding-error")).toContainText("temporarily unavailable");
  await expect(words).toHaveValue(draft);
  await page.getByRole("button", { name: "Build my profile" }).click();
  await expect(page.getByText(rebuiltProfile)).toBeVisible();
  expect(openAttempts).toBe(2);
  expect(synthesisAttempts).toBe(2);

  await page.getByRole("button", { name: "Edit profile" }).click();
  await page.getByLabel("Edit preference profile").fill("   ");
  await page.getByRole("button", { name: "Save my changes" }).click();
  await expect(page.getByText("Write a profile of 2 to 5 sentences.")).toBeVisible();
  await expect(page.getByLabel("Edit preference profile")).toBeFocused();
});

test("locks saved-answer editing while a held synthesis completes", async ({ page }) => {
  const state = stateAt("synthesize");
  state.draft_profile = null;
  let releaseSynthesis = () => {};
  const heldSynthesis = new Promise<void>((resolve) => { releaseSynthesis = resolve; });
  await page.route("**/api/personal/onboarding**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/personal/onboarding", "") || "/";
    if (request.method() === "GET" || path === "/open-response") return respond(route, state);
    if (path === "/synthesize") {
      await heldSynthesis;
      state.draft_profile = rebuiltProfile;
      state.current_step = "profile_review";
    }
    return respond(route, state);
  });

  await page.goto("/onboarding");
  await page.getByRole("button", { name: "Build my profile" }).click();
  await expect(page.getByRole("button", { name: "Building your profile…" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Back" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Edit" }).first()).toBeDisabled();
  await expect(page.getByLabel("In your own words")).toBeDisabled();
  releaseSynthesis();
  await expect(page.getByText(rebuiltProfile)).toBeVisible();
});

test("validates timezone and delivery days before saving and retains edits on retry", async ({ page }) => {
  const state = stateAt("delivery");
  let deliveryAttempts = 0;
  let savedPayload: Record<string, unknown> | null = null;
  await page.route("**/api/personal/onboarding**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/personal/onboarding", "") || "/";
    if (request.method() === "GET") return respond(route, state);
    if (path === "/delivery") {
      deliveryAttempts += 1;
      savedPayload = request.postDataJSON();
      if (deliveryAttempts === 1) return respond(route, { detail: "Delivery could not be saved. Try again." }, 503);
      state.delivery = savedPayload as Delivery;
      state.current_step = "telegram";
    }
    return respond(route, state);
  });

  await page.goto("/onboarding");
  const timezone = page.getByLabel("Timezone");
  await timezone.fill("+08:00");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText(/Enter a valid IANA timezone/)).toBeVisible();
  await expect(timezone).toBeFocused();
  await expect(timezone).toHaveValue("+08:00");
  expect(deliveryAttempts).toBe(0);

  await page.getByRole("button", { name: "Tue" }).click();
  await page.getByRole("button", { name: "Fri" }).click();
  await timezone.fill(" us/pacific ");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("Choose at least one delivery day.")).toBeVisible();
  await expect(page.getByRole("group", { name: "Delivery days" })).toBeFocused();
  expect(deliveryAttempts).toBe(0);

  await page.getByRole("button", { name: "Tue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator(".onboarding-error")).toContainText("could not be saved");
  await expect(timezone).toHaveValue("America/Los_Angeles");
  await expect(page.getByRole("button", { name: "Tue" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Where should we send your picks?" })).toBeVisible();
  expect(savedPayload).toEqual({ timezone: "America/Los_Angeles", cadence_days: [2], delivery_hour: 9, recommendation_count: 1 });
  expect(deliveryAttempts).toBe(2);
});

test("shows manual Telegram connection and an explicit deep link without an async popup", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-09-06T22:00:00Z") });
  const state = stateAt("telegram");
  let linkCalls = 0;
  const completionPayloads: Record<string, unknown>[] = [];
  await page.route("**/api/personal/account/telegram-link", (route) => {
    linkCalls += 1;
    return respond(route, linkCalls === 1
      ? { url: "https://t.me/finitefeedbot?start=synthetic-token", code: "824619", expires_at: "2026-09-06T22:10:00Z" }
      : { url: "https://t.me/finitefeedbot?start=replacement-token", code: "135790", expires_at: "2026-09-06T22:21:00Z" });
  });
  await page.route("**/api/personal/onboarding**", async (route) => {
    const request = route.request();
    if (request.method() === "GET") return respond(route, state);
    const body = request.postDataJSON() as Record<string, unknown>;
    completionPayloads.push(body);
    if (body.telegram === "connected") return respond(route, { detail: "Connect Telegram before choosing connected" }, 409);
    state.status = "completed";
    state.current_step = "completed";
    return respond(route, state);
  });
  await mockAccountShell(page);
  let popups = 0;
  page.on("popup", () => { popups += 1; });

  await page.goto("/onboarding");
  await page.getByRole("button", { name: "Get Telegram connection options" }).click();
  await expect(page.getByLabel("Your six-digit Telegram connection code")).toHaveText("824619");
  await expect(page.locator("time")).toHaveAttribute("datetime", "2026-09-06T22:10:00Z");
  await expect(page.locator("time")).toContainText("This code expires at");
  await expect(page.getByRole("link", { name: "Open Telegram" })).toHaveAttribute("href", "https://t.me/finitefeedbot?start=synthetic-token");
  expect(linkCalls).toBe(1);
  expect(popups).toBe(0);
  await expect(page.getByText("Email and SMS delivery isn’t available yet.")).toBeVisible();
  await expect(page.getByRole("heading", { name: /Email|SMS/ })).toHaveCount(0);

  await page.getByRole("button", { name: "I’ve connected Telegram" }).click();
  await expect(page.locator(".onboarding-error")).toContainText("Connect Telegram before choosing connected");
  await expect(page.getByLabel("Your six-digit Telegram connection code")).toHaveText("824619");

  await page.clock.fastForward("11:00");
  await expect(page.locator("time")).toContainText("This code expired at");
  await expect(page.getByRole("link", { name: "Open Telegram" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "I’ve connected Telegram" })).toHaveCount(0);
  await page.getByRole("button", { name: "Get a new code" }).click();
  await expect(page.getByLabel("Your six-digit Telegram connection code")).toHaveText("135790");
  await expect(page.getByRole("link", { name: "Open Telegram" })).toHaveAttribute("href", "https://t.me/finitefeedbot?start=replacement-token");
  expect(linkCalls).toBe(2);
  await page.getByRole("button", { name: "Use dashboard only" }).click();
  await expect(page).toHaveURL(/\/app$/);
  expect(completionPayloads).toEqual([{ telegram: "connected" }, { telegram: "skipped" }]);
});

test("redirects to sign-in when Telegram connection authorization expires", async ({ page }) => {
  const state = stateAt("telegram");
  await page.route("**/api/personal/onboarding**", (route) => respond(route, state));
  await page.route("**/api/personal/account/telegram-link", (route) => respond(route, { detail: "Sign in" }, 401));
  await page.goto("/onboarding");
  await page.getByRole("button", { name: "Get Telegram connection options" }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("reloads saved progress and captures overflow-free desktop and mobile fixtures", async ({ page }) => {
  const state = stateAt("question_2");
  state.answers = { "1": "technology_ai" };
  state.open_response = null;
  state.draft_profile = null;
  await page.route("**/api/personal/onboarding**", (route) => respond(route, state));
  await page.route("**/api/personal/account/telegram-link", (route) => respond(route, { url: "https://t.me/finitefeedbot?start=synthetic-token", code: "824619", expires_at: "2099-09-06T22:10:00Z" }));
  await mkdir("test-results/onboarding-ux", { recursive: true });

  await page.goto("/onboarding");
  await expect(page.getByRole("heading", { name: questions[1].prompt })).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByRole("radio", { name: "Technology & AI" })).toBeChecked();
  await page.reload();
  await expect(page.getByRole("heading", { name: questions[1].prompt })).toBeVisible();

  state.current_step = "telegram";
  state.answers = { "1": "technology_ai", "2": "deep_understanding", "3": "concise_focused" };
  state.open_response = savedWords;
  state.draft_profile = savedProfile;
  state.delivery = { ...savedDelivery };
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/onboarding");
  await page.getByRole("button", { name: "Get Telegram connection options" }).click();
  await page.screenshot({ path: "test-results/onboarding-ux/desktop-telegram.png", fullPage: true });

  state.current_step = "profile_review";
  state.delivery = null;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/onboarding");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const stages = page.getByRole("navigation", { name: "Onboarding stages" });
  expect(await stages.getByLabel("Profile", { exact: true }).evaluate((stage) => {
    const bounds = stage.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= window.innerWidth;
  })).toBe(true);
  await page.screenshot({ path: "test-results/onboarding-ux/mobile-390-profile.png", fullPage: true });

  state.current_step = "delivery";
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/onboarding");
  await page.getByLabel("Timezone").fill("Invalid/Timezone");
  await page.getByRole("button", { name: "Continue" }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await stages.getByLabel("Delivery", { exact: true }).evaluate((stage) => {
    const bounds = stage.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= window.innerWidth;
  })).toBe(true);
  await page.screenshot({ path: "test-results/onboarding-ux/mobile-320-delivery-error.png", fullPage: true });
});
