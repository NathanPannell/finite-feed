import { appVersion } from "@/lib/app-version";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(appVersion, {
    headers: { "Cache-Control": "no-store" },
  });
}
