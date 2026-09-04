import { matchApiBaseUrl, proxyMatchRequest } from "../match-proxy";

export const dynamic = "force-dynamic";

type MatchRouteContext = { params: Promise<{ path?: string[] }> };

async function handle(request: Request, context: MatchRouteContext) {
  const { path = [] } = await context.params;
  return proxyMatchRequest(request, path, matchApiBaseUrl());
}

export async function GET(request: Request, context: MatchRouteContext) {
  return handle(request, context);
}

export async function POST(request: Request, context: MatchRouteContext) {
  return handle(request, context);
}
