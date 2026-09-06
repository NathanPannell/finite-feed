import { adminRouteDecision } from "@/lib/admin-route-gate";
import { getAuth } from "@/lib/auth/server";
import { finishOAuthRedirect } from "@/lib/auth/callback";
import { NextRequest, NextResponse } from "next/server";

export async function proxy(request: NextRequest) {
  const isAdmin = request.nextUrl.pathname.startsWith("/admin") || request.nextUrl.pathname.startsWith("/api/admin");
  if (!isAdmin && request.nextUrl.searchParams.has("neon_auth_session_verifier")) {
    const response = await getAuth().middleware()(request);
    return finishOAuthRedirect(response, request.url);
  }
  if (!isAdmin) {
    return NextResponse.next();
  }
  const decision = adminRouteDecision({
    nodeEnv: process.env.NODE_ENV,
    vercelEnv: process.env.VERCEL_ENV,
    vercelUrl: process.env.VERCEL_URL,
    requestHostname: request.nextUrl.hostname,
  });

  if (decision.kind === "allow") {
    return NextResponse.next();
  }
  if (decision.kind === "deny") {
    return new NextResponse("Admin route unavailable.", { status: 503 });
  }

  const destination = request.nextUrl.clone();
  destination.protocol = "https:";
  destination.host = decision.host;
  destination.port = "";
  return NextResponse.redirect(destination, 307);
}

export const config = {
  matcher: ["/", "/app/:path*", "/auth/callback", "/admin/:path*", "/api/admin/:path*"],
};
