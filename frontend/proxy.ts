import { adminRouteDecision } from "@/lib/admin-route-gate";
import { NextRequest, NextResponse } from "next/server";

export function proxy(request: NextRequest) {
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
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};
