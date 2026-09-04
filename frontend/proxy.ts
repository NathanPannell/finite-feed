import { NextRequest, NextResponse } from "next/server";

export function proxy(request: NextRequest) {
  if (process.env.VERCEL_ENV !== "production") {
    return NextResponse.next();
  }

  const deploymentHost = process.env.VERCEL_URL?.trim().toLowerCase();
  if (!deploymentHost) {
    return new NextResponse("Admin route unavailable.", { status: 503 });
  }

  if (request.nextUrl.hostname.toLowerCase() === deploymentHost) {
    return NextResponse.next();
  }

  const destination = request.nextUrl.clone();
  destination.protocol = "https:";
  destination.host = deploymentHost;
  destination.port = "";
  return NextResponse.redirect(destination, 307);
}

export const config = {
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};
