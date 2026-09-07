import { expect, test, type Page, type Route } from "@playwright/test";

const longCard = {
  profile_id: "profile-ux",
  video_id: "video-ux",
  summary: "I help public-interest teams make careful technology decisions. I want practical evidence, explicit tradeoffs, and examples that separate measurable outcomes from broad promises or trend-driven claims.",
  topics: ["public interest", "technology policy", "evidence"],
  title: "A careful guide to technology decisions",
  description: "This detailed candidate description explains a practical decision framework, the evidence behind it, the limits of the available data, and several examples that help a reviewer decide whether it fits the viewer without relying on the title alone.",
};

function json(route: Route, body: unknown) {
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

async function serveCard(page: Page, card: typeof longCard | null = longCard) {
  await page.route("**/api/match/annotations**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/next")) return json(route, card);
    if (request.method() === "POST") return json(route, { saved: true });
    return json(route, {});
  });
}

test("uses one native radio group with arrow-key selection and visible state", async ({ page }, testInfo) => {
  await serveCard(page);
  await page.goto("/match/review");

  const radios = page.getByRole("radio");
  const yes = page.getByRole("radio", { name: "Yes", exact: true });
  const no = page.getByRole("radio", { name: "No", exact: true });
  const unsure = page.getByRole("radio", { name: "Unsure", exact: true });
  await expect(radios).toHaveCount(3);

  await yes.focus();
  await page.keyboard.press("ArrowDown");
  await expect(no).toBeFocused();
  await expect(no).toBeChecked();
  await expect(yes).not.toBeChecked();
  await page.keyboard.press("ArrowDown");
  await expect(unsure).toBeFocused();
  await expect(unsure).toBeChecked();
  await expect(unsure).toHaveAccessibleDescription("Not enough evidence Choose Unsure when the evidence is incomplete.");
  await expect(page.locator('label:has(input[type="radio"]:checked)').getByText("Selected", { exact: true })).toBeVisible();
  await expect(page.getByText("Selected", { exact: true })).toHaveCount(1);
  await expect(page.locator('input[type="radio"]:checked')).toHaveCount(1);

  const choiceVisuals = await page.locator('label:has(input[name="match-judgment"])').evaluateAll((labels) => labels.map((label) => {
    const input = label.querySelector<HTMLInputElement>('input[name="match-judgment"]')!;
    const spans = label.querySelectorAll("span");
    const style = getComputedStyle(label);
    return {
      checked: input.checked,
      background: style.backgroundColor,
      borderTopWidth: style.borderTopWidth,
      nameColor: getComputedStyle(spans[0]).color,
      nameSize: Number.parseFloat(getComputedStyle(spans[0]).fontSize),
      definitionColor: getComputedStyle(spans[1]).color,
      definitionSize: Number.parseFloat(getComputedStyle(spans[1]).fontSize),
      stateColor: spans[2] ? getComputedStyle(spans[2]).color : null,
    };
  }));
  for (const choice of choiceVisuals) {
    expect(choice.borderTopWidth).toBe("1px");
    expect(choice.nameSize).toBeGreaterThanOrEqual(14);
    expect(choice.definitionSize).toBeGreaterThanOrEqual(12);
    expect(choice.nameColor).toBe(choice.checked ? "rgb(17, 17, 17)" : "rgb(250, 249, 242)");
    expect(choice.definitionColor).toBe(choice.checked ? "rgb(17, 17, 17)" : "rgb(250, 249, 242)");
    if (choice.checked) {
      expect(choice.background).toBe("rgb(250, 249, 242)");
      expect(choice.stateColor).toBe("rgb(17, 17, 17)");
    }
  }

  const focusOutline = await unsure.evaluate((radio) => getComputedStyle(radio.closest("label")!).outlineStyle);
  expect(focusOutline).not.toBe("none");
  if (process.env.MATCH_SCREENSHOTS) await page.screenshot({ path: testInfo.outputPath("match-desktop-selected.png"), fullPage: true });
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Reason Optional. It is useful for close calls.")).toBeFocused();
});

for (const viewport of [{ width: 320, height: 800 }, { width: 390, height: 844 }]) {
  test(`keeps compact evidence and reachable choices at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await serveCard(page);
    await page.goto("/match/review");
    await page.getByRole("radio", { name: "Unsure", exact: true }).check();

    const geometry = await page.locator(".match-workspace").evaluate((workspace) => {
      const firstChoice = workspace.querySelector("input[type=radio]")?.closest("label")?.getBoundingClientRect();
      const judgment = workspace.querySelector("aside")?.getBoundingClientRect();
      const navigation = document.querySelector(".signal-mobile-nav")?.getBoundingClientRect();
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        judgmentTop: judgment?.top ?? Number.POSITIVE_INFINITY,
        firstChoiceHeight: firstChoice?.height ?? 0,
        firstChoiceBottom: firstChoice?.bottom ?? Number.POSITIVE_INFINITY,
        navigationTop: navigation?.top ?? 0,
        responsePosition: judgment ? getComputedStyle(workspace.querySelector("aside")!).position : "missing",
      };
    });
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(geometry.judgmentTop).toBeLessThan(viewport.height);
    expect(geometry.firstChoiceHeight).toBeGreaterThanOrEqual(44);
    expect(geometry.firstChoiceBottom).toBeLessThanOrEqual(geometry.navigationTop);
    expect(["fixed", "sticky"]).not.toContain(geometry.responsePosition);
    if (process.env.MATCH_SCREENSHOTS) await page.screenshot({ path: testInfo.outputPath(`match-${viewport.width}px.png`), fullPage: true });

    const profileToggle = page.getByRole("button", { name: "Show full profile" });
    const descriptionToggle = page.getByRole("button", { name: "Show full description" });
    await expect(profileToggle).toBeVisible();
    await expect(descriptionToggle).toBeVisible();
    const collapsedProfile = await page.locator(".profile-summary").evaluate((profile) => profile.clientHeight);
    await profileToggle.click();
    const expandedProfile = await page.locator(".profile-summary").evaluate((profile) => ({ client: profile.clientHeight, scroll: profile.scrollHeight }));
    expect(expandedProfile.client).toBeGreaterThan(collapsedProfile);
    expect(Math.abs(expandedProfile.client - expandedProfile.scroll)).toBeLessThanOrEqual(1);
    await descriptionToggle.click();
    const expandedDescription = await page.locator(".video-description").evaluate((description) => ({ client: description.clientHeight, scroll: description.scrollHeight }));
    expect(Math.abs(expandedDescription.client - expandedDescription.scroll)).toBeLessThanOrEqual(1);
  });
}

test("gives the completed empty state a clear next action", async ({ page }) => {
  await serveCard(page, null);
  await page.goto("/match/review");
  await expect(page.getByRole("heading", { name: "No more pairs are available for you right now." })).toBeVisible();
  await expect(page.getByRole("link", { name: "See how Match Lab works" })).toHaveAttribute("href", "/match");
  await expect(page.locator(".sr-only[role='status']")).toHaveText("No more pairs are available for you right now.");
});
