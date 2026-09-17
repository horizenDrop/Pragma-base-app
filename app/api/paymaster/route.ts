import { NextRequest, NextResponse } from "next/server";

// Only the JSON-RPC methods a wallet needs for sponsorship. Without this the
// route is an open relay: anyone can post arbitrary requests to the paymaster
// and burn the sponsorship budget.
const ALLOWED_METHODS = new Set([
  "pm_getPaymasterStubData",
  "pm_getPaymasterData",
  "pm_getPaymasterAndData",
  "pm_sponsorUserOperation",
  "pm_supportedEntryPoints"
]);

const MAX_BODY_BYTES = 32 * 1024;
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

const buckets = new Map<string, { count: number; resetAt: number }>();

function clientKey(request: NextRequest) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || "unknown";
}

function rateLimited(key: string) {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    if (buckets.size > 5000) buckets.clear();
    buckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }

  bucket.count += 1;
  return bucket.count > RATE_LIMIT;
}

function sameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin) return true; // non-browser callers send no Origin
  try {
    return new URL(origin).host === request.nextUrl.host;
  } catch {
    return false;
  }
}

function methodsOf(payload: unknown): string[] {
  const calls = Array.isArray(payload) ? payload : [payload];
  return calls.map((call) => {
    if (!call || typeof call !== "object") return "";
    return String((call as { method?: unknown }).method ?? "");
  });
}

export async function POST(request: NextRequest) {
  const paymasterUrl = process.env.PAYMASTER_SERVICE_URL;
  if (!paymasterUrl) {
    return NextResponse.json(
      { error: "PAYMASTER_SERVICE_URL is not configured" },
      { status: 500 }
    );
  }

  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "Forbidden origin" }, { status: 403 });
  }

  if (rateLimited(clientKey(request))) {
    return NextResponse.json({ error: "Too many paymaster requests" }, { status: 429 });
  }

  let body: string;
  try {
    body = await request.text();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (body.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const methods = methodsOf(parsed);
  if (!methods.length || !methods.every((method) => ALLOWED_METHODS.has(method))) {
    return NextResponse.json({ error: "Unsupported paymaster method" }, { status: 400 });
  }

  try {
    const upstream = await fetch(paymasterUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body,
      cache: "no-store"
    });

    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: { "content-type": "application/json" }
    });
  } catch {
    return NextResponse.json({ error: "Paymaster proxy request failed" }, { status: 502 });
  }
}
