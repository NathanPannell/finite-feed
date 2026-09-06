import "server-only";
type Context = { params: Promise<{ path: string[] }> };

async function proxy(request: Request, context: Context) {
  const { path: parts } = await context.params;
  const path = parts.join("/");
  if (!/^(account(?:\/(?:delivery|preferences|telegram-link|telegram|export))?|profile(?:\/(?:delivery|memory))?|channels(?:\/(?:resolve|[0-9a-f-]+))?|recommendations(?:\/(?:generate|[0-9a-f-]+\/feedback))?|metrics|pipeline\/status|r\/[0-9a-f-]+)$/i.test(path)) {
    return Response.json({ detail: "Route not found" }, { status: 404 });
  }
  if (request.method !== "GET" && request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ detail: "Invalid request origin" }, { status: 403 });
  }
  const base = process.env.RAILWAY_API_BASE_URL;
  if (!base) return Response.json({ detail: "API is not configured" }, { status: 503 });
  try {
    const response = await fetch(new URL(path.startsWith("r/") ? `/${path}` : `/api/${path}`, base), {
      method: request.method,
      headers: { Cookie: request.headers.get("cookie") ?? "", "Content-Type": "application/json" },
      body: request.method === "GET" ? undefined : await request.arrayBuffer(),
      redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(90_000),
    });
    const headers = new Headers({ "Cache-Control": "no-store", "Content-Type": response.headers.get("content-type") ?? "application/json" });
    if (response.headers.has("location")) headers.set("Location", response.headers.get("location")!);
    return new Response(response.body, { status: response.status, headers });
  } catch {
    return Response.json({ detail: "The API is temporarily unavailable. Try again." }, { status: 502 });
  }
}
export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const DELETE = proxy;
export const dynamic = "force-dynamic";
