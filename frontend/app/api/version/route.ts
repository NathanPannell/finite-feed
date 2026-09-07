import { appVersion } from "@/lib/app-version";

export const dynamic = "force-static";

export function GET() {
  return Response.json(appVersion, {
    headers: { "Cache-Control": "public, max-age=300, immutable" },
  });
}
