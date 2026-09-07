export type HomepageFeatureFlags = {
  matchLabHomepageVisible: boolean;
};

const defaults: HomepageFeatureFlags = { matchLabHomepageVisible: true };

export async function loadHomepageFeatureFlags(
  baseUrl = process.env.RAILWAY_API_BASE_URL,
  request: typeof fetch = fetch,
): Promise<HomepageFeatureFlags> {
  if (!baseUrl) return defaults;
  try {
    const response = await request(new URL("/api/features", baseUrl), {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return defaults;
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object") return defaults;
    const visible = (payload as Record<string, unknown>).match_lab_homepage_visible;
    return { matchLabHomepageVisible: typeof visible === "boolean" ? visible : true };
  } catch {
    return defaults;
  }
}
