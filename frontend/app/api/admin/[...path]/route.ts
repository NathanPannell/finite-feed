import "server-only";

import { getVercelOidcToken } from "@vercel/oidc";

type RouteContext = { params: Promise<{ path: string[] }> };

const allowedRequests = new Map<string, Set<string>>([
  ["summary", new Set(["GET"])],
  ["activity", new Set(["GET"])],
  ["performance", new Set(["GET"])],
  ["feature-flags/match-lab-homepage", new Set(["GET", "PATCH"])],
  ["channels", new Set(["GET", "POST"])],
  ["channels/resolve", new Set(["POST"])],
  ["videos", new Set(["GET"])],
  ["videos/vector-search", new Set(["POST"])],
  ["recommendations", new Set(["GET"])],
]);

function allowed(path: string, method: string) {
  if (allowedRequests.get(path)?.has(method)) return true;
  if (/^(channels|videos|recommendations)\/[0-9a-f-]+$/i.test(path)) {
    return method === "GET" || (path.startsWith("channels/") && method === "PATCH");
  }
  return false;
}

function jsonError(detail: string, status: number) {
  return Response.json({ detail }, { status });
}

async function proxyAdmin(request: Request, context: RouteContext) {
  const { path: parts } = await context.params;
  const path = parts.join("/");
  if (!allowed(path, request.method)) return jsonError("Admin route not found.", 404);

  const base = process.env.RAILWAY_API_BASE_URL;
  if (!base) return jsonError("The admin API is not configured for this deployment.", 503);

  try {
    const target = new URL(`/api/admin/${path}`, base);
    target.search = new URL(request.url).search;
    const token = await getVercelOidcToken({ expirationBufferMs: 30_000 });
    const contentType = request.headers.get("content-type");
    const response = await fetch(target, {
      method: request.method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
      },
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });

    return new Response(response.body, {
      status: response.status,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": response.headers.get("content-type") ?? "application/json",
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      return jsonError("The admin API timed out. Try again.", 504);
    }
    return jsonError("The admin API is unavailable. Try again.", 502);
  }
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = proxyAdmin;
export const POST = proxyAdmin;
export const PATCH = proxyAdmin;
