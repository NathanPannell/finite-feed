import { getAuth } from "@/lib/auth/server";
type Context = { params: Promise<{ path: string[] }> };
async function handler(request: Request, context: Context) {
  if (!process.env.NEON_AUTH_BASE_URL || !process.env.NEON_AUTH_COOKIE_SECRET) {
    return Response.json({ message: "Sign-in is not configured for this deployment." }, { status: 503 });
  }
  const handlers = getAuth().handler();
  return request.method === "GET" ? handlers.GET(request, context) : handlers.POST(request, context);
}
export const GET = handler;
export const POST = handler;
export const dynamic = "force-dynamic";
