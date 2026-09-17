import { NextRequest, NextResponse } from "next/server";
import { readOnchainBestScore } from "@/lib/chain";

type LeaderboardEntry = {
  address: string;
  bestScore: number;
  verifiedBestScore: number;
  lastScore: number;
  totalRuns: number;
  level: number;
  levelXp: number;
  updatedAt: number;
};

const KV_URL = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
const REDIS_URL = process.env.REDIS_URL;
const KV_KEY = "pragma:leaderboard:v1";
const LOCK_KEY = "pragma:leaderboard:lock";
const MAX_ENTRIES = 1000;
const MAX_SCORE = 10_000_000;
const MAX_XP_PER_RUN = 100_000;
const MAX_LEVEL = 500;

const store = globalThis as unknown as {
  pragmaLeaderboard?: Map<string, LeaderboardEntry>;
  pragmaRedisClient?: any;
};

if (!store.pragmaLeaderboard) {
  store.pragmaLeaderboard = new Map<string, LeaderboardEntry>();
}

async function kvCommand(command: unknown[]) {
  if (!KV_URL || !KV_TOKEN) return null;
  const response = await fetch(KV_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(command),
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`KV command failed with status ${response.status}`);
  }
  const json = (await response.json()) as { result?: unknown };
  return json.result ?? null;
}

async function getRedisClient() {
  if (!REDIS_URL) return null;
  if (store.pragmaRedisClient?.isOpen) return store.pragmaRedisClient;

  store.pragmaRedisClient = undefined;
  const { createClient } = await import("redis");
  const client = createClient({ url: REDIS_URL, socket: { connectTimeout: 5000 } });
  client.on("error", () => null);
  await client.connect();
  store.pragmaRedisClient = client;
  return client;
}

async function readEntries() {
  if (KV_URL && KV_TOKEN) {
    const result = await kvCommand(["GET", KV_KEY]);
    if (typeof result === "string" && result.length > 0) {
      const parsed = JSON.parse(result) as LeaderboardEntry[];
      return parsed;
    }
    return [];
  }
  if (REDIS_URL) {
    const client = await getRedisClient();
    if (!client) return [];
    const raw = await client.get(KV_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as LeaderboardEntry[];
    return parsed;
  }
  return [...store.pragmaLeaderboard!.values()];
}

async function writeEntries(entries: LeaderboardEntry[]) {
  if (KV_URL && KV_TOKEN) {
    await kvCommand(["SET", KV_KEY, JSON.stringify(entries)]);
    return;
  }
  if (REDIS_URL) {
    const client = await getRedisClient();
    if (!client) return;
    await client.set(KV_KEY, JSON.stringify(entries));
    return;
  }
  store.pragmaLeaderboard = new Map(entries.map((entry) => [entry.address, entry]));
}

async function acquireLock(ttlMs = 5_000) {
  if (KV_URL && KV_TOKEN) {
    const result = await kvCommand(["SET", LOCK_KEY, "1", "NX", "PX", String(ttlMs)]);
    return result === "OK";
  }
  if (REDIS_URL) {
    const client = await getRedisClient();
    if (!client) return true;
    const result = await client.set(LOCK_KEY, "1", { NX: true, PX: ttlMs });
    return result === "OK";
  }
  return true;
}

async function releaseLock() {
  try {
    if (KV_URL && KV_TOKEN) {
      await kvCommand(["DEL", LOCK_KEY]);
      return;
    }
    if (REDIS_URL) {
      const client = await getRedisClient();
      await client?.del(LOCK_KEY);
    }
  } catch {
    // the lock expires on its own
  }
}

async function withLeaderboardLock<T>(fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await acquireLock()) {
      try {
        return await fn();
      } finally {
        await releaseLock();
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

function sortEntries(entries: LeaderboardEntry[]) {
  return [...entries].sort((a, b) => {
    const aVerified = a.verifiedBestScore ?? 0;
    const bVerified = b.verifiedBestScore ?? 0;
    if (bVerified !== aVerified) {
      return bVerified - aVerified;
    }
    if (b.bestScore !== a.bestScore) return b.bestScore - a.bestScore;
    return b.updatedAt - a.updatedAt;
  });
}

// Keep the stored document bounded; the caller's own entry is always retained
// so a new player never disappears right after submitting.
function capEntries(entries: LeaderboardEntry[], keepAddress: string) {
  if (entries.length <= MAX_ENTRIES) return entries;
  const sorted = sortEntries(entries);
  const kept = sorted.slice(0, MAX_ENTRIES);
  if (!kept.some((entry) => entry.address === keepAddress)) {
    const own = sorted.find((entry) => entry.address === keepAddress);
    if (own) kept[kept.length - 1] = own;
  }
  return kept;
}

function toSafeInt(value: unknown, max: number) {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) return 0;
  return Math.min(max, Math.max(0, Math.floor(numeric)));
}

function getSorted() {
  return [...store.pragmaLeaderboard!.values()].sort((a, b) => {
    const aVerified = a.verifiedBestScore ?? 0;
    const bVerified = b.verifiedBestScore ?? 0;
    if (bVerified !== aVerified) {
      return bVerified - aVerified;
    }
    if (b.bestScore !== a.bestScore) return b.bestScore - a.bestScore;
    return b.updatedAt - a.updatedAt;
  });
}

function normalizeAddress(value: string) {
  return value.trim().toLowerCase();
}

function xpForNextLevel(level: number) {
  return 40 + level * 30 + level * level * 6;
}

function normalizeEntry(entry: Partial<LeaderboardEntry> & { address: string }): LeaderboardEntry {
  return {
    address: normalizeAddress(entry.address),
    bestScore: toSafeInt(entry.bestScore, MAX_SCORE),
    verifiedBestScore: toSafeInt(entry.verifiedBestScore, MAX_SCORE),
    lastScore: toSafeInt(entry.lastScore, MAX_SCORE),
    totalRuns: toSafeInt(entry.totalRuns, Number.MAX_SAFE_INTEGER),
    level: Math.max(1, toSafeInt(entry.level ?? 1, MAX_LEVEL)),
    levelXp: toSafeInt(entry.levelXp, Number.MAX_SAFE_INTEGER),
    updatedAt: toSafeInt(entry.updatedAt ?? Date.now(), Number.MAX_SAFE_INTEGER)
  };
}

function applyXpProgress(level: number, levelXp: number, xpGained: number) {
  let currentLevel = Math.min(MAX_LEVEL, Math.max(1, level));
  let currentLevelXp = toSafeInt(levelXp, Number.MAX_SAFE_INTEGER) + toSafeInt(xpGained, MAX_XP_PER_RUN);
  // MAX_LEVEL also bounds the loop: an unbounded xpGained used to spin here
  // forever and hang the request.
  while (currentLevel < MAX_LEVEL && currentLevelXp >= xpForNextLevel(currentLevel)) {
    currentLevelXp -= xpForNextLevel(currentLevel);
    currentLevel += 1;
  }
  return { level: currentLevel, levelXp: currentLevelXp };
}

function profileFromEntry(entry: LeaderboardEntry) {
  const nextXp = xpForNextLevel(entry.level);
  const damage = Number((1 + (entry.level - 1) * 0.15).toFixed(2));
  const maxHp = 3 + Math.floor((entry.level - 1) / 2);
  return {
    ...entry,
    nextLevelXp: nextXp,
    damage,
    maxHp
  };
}

export async function GET(request: NextRequest) {
  try {
    const address = request.nextUrl.searchParams.get("address");
    const entries = await readEntries();
    const normalizedEntries = entries.map((entry) => normalizeEntry(entry));
    store.pragmaLeaderboard = new Map(normalizedEntries.map((entry) => [entry.address, entry]));
    const leaderboard = getSorted().slice(0, 100);
    if (!address) {
      return NextResponse.json({
        leaderboard: leaderboard.map((entry) => profileFromEntry(entry))
      });
    }
    const profile = store.pragmaLeaderboard!.get(normalizeAddress(address)) ?? null;
    return NextResponse.json({
      leaderboard: leaderboard.map((entry) => profileFromEntry(entry)),
      profile: profile ? profileFromEntry(profile) : null
    });
  } catch (error) {
    // Upstream errors can carry storage URLs and tokens; keep them in the logs.
    console.error("leaderboard.get_failed", error);
    return NextResponse.json({ error: "Failed to load leaderboard" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      address?: string;
      score?: number;
      verified?: boolean;
      xpGained?: number;
    };
    if (!body.address || typeof body.score !== "number" || !Number.isFinite(body.score)) {
      return NextResponse.json({ error: "address and score are required" }, { status: 400 });
    }
    const address = normalizeAddress(body.address);
    if (!/^0x[a-f0-9]{40}$/.test(address)) {
      return NextResponse.json({ error: "invalid address" }, { status: 400 });
    }
    const score = toSafeInt(body.score, MAX_SCORE);
    const xpGained = toSafeInt(body.xpGained, MAX_XP_PER_RUN);

    // "verified" used to be whatever the client claimed, so any caller could
    // post a perfect verified score. Confirm it against the game contract.
    const onchainBest = body.verified === true ? await readOnchainBestScore(address) : null;

    const updated = await withLeaderboardLock(async () => {
      const entries = await readEntries();
      const normalizedEntries = entries.map((entry) => normalizeEntry(entry));
      const map = new Map(normalizedEntries.map((entry) => [entry.address, entry]));
      const prev = map.get(address);
      const xpProgress = applyXpProgress(prev?.level ?? 1, prev?.levelXp ?? 0, xpGained);
      const verifiedBest = onchainBest === null
        ? (prev?.verifiedBestScore ?? 0)
        : Math.max(prev?.verifiedBestScore ?? 0, toSafeInt(onchainBest, MAX_SCORE));

      const next: LeaderboardEntry = {
        address,
        bestScore: Math.max(prev?.bestScore ?? 0, score),
        verifiedBestScore: verifiedBest,
        lastScore: score,
        totalRuns: (prev?.totalRuns ?? 0) + 1,
        level: xpProgress.level,
        levelXp: xpProgress.levelXp,
        updatedAt: Date.now()
      };

      map.set(address, next);
      const updatedEntries = capEntries([...map.values()], address);
      await writeEntries(updatedEntries);
      store.pragmaLeaderboard = new Map(updatedEntries.map((entry) => [entry.address, entry]));
      return next;
    });

    return NextResponse.json({
      profile: profileFromEntry(updated),
      leaderboard: getSorted()
        .slice(0, 100)
        .map((entry) => profileFromEntry(entry))
    });
  } catch (error) {
    console.error("leaderboard.post_failed", error);
    return NextResponse.json({ error: "Failed to save run" }, { status: 500 });
  }
}
