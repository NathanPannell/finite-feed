import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const dynamic = "force-static";

export async function GET() {
  const font = await readFile(join(process.cwd(), "assets/fonts/BarlowCondensed-Bold.ttf"));

  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "#f2f1ea", color: "#111111", fontFamily: "Barlow", padding: "42px 54px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "2px solid #111111", paddingBottom: 22 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 32 }}><span style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 50, height: 50, color: "#f2f1ea", background: "#111111" }}>F/</span>FINITE FEED</div>
        <div style={{ display: "flex", fontSize: 25, color: "#3157e8" }}>A FEED WITH A FINISH LINE</div>
      </div>
      <div style={{ display: "flex", flex: 1, gap: 44, alignItems: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", width: 430 }}>
          <div style={{ display: "flex", fontSize: 88, lineHeight: .82 }}>YOUR ATTENTION HAS BETTER PLACES TO BE.</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", flex: 1, background: "#faf9f2", boxShadow: "18px 18px 0 #3157e8", padding: 30, transform: "rotate(-1deg)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", color: "#3157e8", fontSize: 20, borderBottom: "2px solid #3157e8", paddingBottom: 12 }}><span>FOR: CREATIVE PRACTICE</span><span>TED · 14:00</span></div>
          <div style={{ display: "flex", fontSize: 52, lineHeight: .9, padding: "24px 0 20px" }}>THE CREATIVE GENIUS OF SNEAKER DESIGN</div>
          <div style={{ display: "flex", borderTop: "1px dashed #111111", paddingTop: 16, fontSize: 22 }}>One video pick. Then you’re done.</div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 14, alignItems: "center", borderTop: "2px solid #111111", paddingTop: 18, fontSize: 22 }}><span style={{ display: "flex", background: "#e6ff2a", padding: "6px 12px" }}>SOURCES</span><span>→</span><span>INTERESTS</span><span>→</span><span>CHOSEN PICKS</span><span>→</span><span>DASHBOARD OR TELEGRAM</span></div>
    </div>,
    { width: 1200, height: 630, fonts: [{ name: "Barlow", data: font, weight: 700, style: "normal" }] },
  );
}
