import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const dynamic = "force-static";

export async function GET() {
  const font = await readFile(join(process.cwd(), "assets/fonts/BarlowCondensed-Bold.ttf"));

  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "#f2f1ea", color: "#111111", fontFamily: "Barlow", padding: "44px 56px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "2px solid #111111", paddingBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 32 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", background: "#111111", color: "#f2f1ea", width: 52, height: 52 }}>F/</div>
          FINITE FEED
        </div>
        <div style={{ display: "flex", fontSize: 32, color: "#3157e8" }}>MATCH LAB</div>
      </div>
      <div style={{ display: "flex", flex: 1, alignItems: "center", fontSize: 100, lineHeight: 1, maxWidth: 950 }}>DOES THIS VIDEO FIT THIS VIEWER?</div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderTop: "2px solid #111111", paddingTop: 24 }}>
        <div style={{ display: "flex", fontSize: 30 }}>Help evaluate video recommendations.</div>
        <div style={{ display: "flex", gap: 8, fontSize: 28 }}>
          {[["YES", "#175d3a", "#faf9f2"], ["NO", "#8e281d", "#faf9f2"], ["UNSURE", "#e6ff2a", "#111111"]].map(([label, background, color]) => (
            <div key={label} style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 110, height: 56, background, color }}>{label}</div>
          ))}
        </div>
      </div>
    </div>,
    { width: 1200, height: 630, fonts: [{ name: "Barlow", data: font, weight: 700, style: "normal" }] },
  );
}
