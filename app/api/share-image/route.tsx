import { ImageResponse } from "next/og";

export const runtime = "edge";

// Query values go straight into the rendered image, so clamp them instead of
// letting a caller push arbitrary length through the renderer.
function readNumber(value: string | null, fallback: number, max: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(0, Math.floor(numeric)));
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const level = String(readNumber(searchParams.get("level"), 1, 999));
  const score = String(readNumber(searchParams.get("score"), 0, 10_000_000));
  const verified = String(readNumber(searchParams.get("verified"), 0, 10_000_000));

  return new ImageResponse(
    (
      <div
        style={{
          width: "1200px",
          height: "630px",
          display: "flex",
          position: "relative",
          background: "#0b0b0b",
          color: "#f5f5f5",
          fontFamily: "Arial, sans-serif",
          overflow: "hidden"
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(circle at 18% 0%, #1f1f1f, #0b0b0b 55%), linear-gradient(180deg, #121212, #090909)"
          }}
        />

        <div
          style={{
            position: "absolute",
            left: "70px",
            top: "70px",
            width: "560px",
            height: "490px",
            border: "1px solid #2b2b2b",
            borderRadius: "16px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background:
              "repeating-linear-gradient(0deg, #101010, #101010 24px, #0d0d0d 24px, #0d0d0d 48px)"
          }}
        >
          <div
            style={{
              width: "72px",
              height: "72px",
              borderRadius: "50%",
              background: "#fff",
              position: "absolute",
              boxShadow: "0 0 28px rgba(255,255,255,0.25)"
            }}
          />
          {[
            { x: 110, y: 110, s: 34 },
            { x: 420, y: 120, s: 30 },
            { x: 220, y: 380, s: 28 },
            { x: 460, y: 340, s: 26 },
            { x: 120, y: 330, s: 24 }
          ].map((e, i) => (
            <div
              key={i}
              style={{
                position: "absolute",
                width: `${e.s}px`,
                height: `${e.s}px`,
                borderRadius: "50%",
                border: "2px solid #fff",
                left: `${e.x}px`,
                top: `${e.y}px`,
                background: "#000"
              }}
            />
          ))}
        </div>

        <div
          style={{
            marginLeft: "670px",
            marginTop: "80px",
            display: "flex",
            flexDirection: "column",
            gap: "18px",
            width: "470px"
          }}
        >
          <div style={{ fontSize: "64px", fontWeight: 700, letterSpacing: "-0.04em" }}>PRAGMA</div>
          <div style={{ fontSize: "24px", color: "#b6b6b6" }}>Onchain Survival Snapshot</div>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: "32px",
              border: "1px solid #2a2a2a",
              borderRadius: "12px",
              padding: "14px 18px",
              background: "#131313"
            }}
          >
            <span>Level</span>
            <strong>{level}</strong>
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: "32px",
              border: "1px solid #2a2a2a",
              borderRadius: "12px",
              padding: "14px 18px",
              background: "#131313"
            }}
          >
            <span>Score</span>
            <strong>{score}</strong>
          </div>

          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: "34px",
              border: "2px solid #fff",
              borderRadius: "12px",
              padding: "14px 18px",
              background: "#0f0f0f"
            }}
          >
            <span>Verified</span>
            <strong>{verified}</strong>
          </div>

          <div style={{ marginTop: "10px", fontSize: "22px", color: "#cfcfcf" }}>
            join in the game to show me your skill
          </div>
          <div style={{ fontSize: "20px", color: "#ffffff" }}>https://base-app-1-bay.vercel.app/</div>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630
    }
  );
}

