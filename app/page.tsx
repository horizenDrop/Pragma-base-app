"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TouchEvent } from "react";
import sdk from "@farcaster/miniapp-sdk";
import { Address, encodeFunctionData, isAddress } from "viem";
import { gameAbi } from "@/lib/gameAbi";

type EthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<any>;
};

type Enemy = {
  id: number;
  x: number;
  y: number;
  r: number;
  speed: number;
  hp: number;
  bladeCd: number;
};
type Bullet = { id: number; x: number; y: number; vx: number; vy: number; life: number };
type BuffType = "haste" | "rapid" | "shield" | "blades" | "wipe";
type BuffPickup = { id: number; x: number; y: number; type: BuffType; life: number };
type SwordView = { id: number; x: number; y: number };
type Phase = "menu" | "playing" | "gameover";
type LeaderboardEntry = {
  address: string;
  bestScore: number;
  verifiedBestScore: number;
  lastScore: number;
  totalRuns: number;
  level: number;
  levelXp: number;
  nextLevelXp: number;
  damage: number;
  maxHp: number;
  updatedAt: number;
};

const CHAIN_ID_HEX = "0x2105";
const WALLET_KEY = "pragma_wallet";
const BUILDER_CODE = "bc_oub26f3r";
const DATA_SUFFIX = "0x62635f6f756232366633720b0080218021802180218021802180218021";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function getGameContractAddress(): Address | null {
  const raw = String(process.env.NEXT_PUBLIC_GAME_CONTRACT_ADDRESS ?? "").trim();
  if (!raw || !isAddress(raw) || raw.toLowerCase() === ZERO_ADDRESS) return null;
  return raw as Address;
}

// Embedded wallet webviews can block storage entirely, where an unguarded
// setItem throws and aborts the connect flow.
function storeWallet(address: string) {
  try {
    window.localStorage.setItem(WALLET_KEY, address);
  } catch {
    // remembering the address is a convenience, not a requirement
  }
}

const DEFAULT_ARENA_WIDTH = 320;
const DEFAULT_ARENA_HEIGHT = 440;
const PLAYER_RADIUS = 10;
const ENEMY_RADIUS = 11;
const BULLET_RADIUS = 3;
const BUFF_RADIUS = 11;
const BUFF_MAGNET_RADIUS = 220;
const BUFF_MAGNET_SPEED = 240;
const WAVE_MS = 4000;
const BUFF_DROP_CHANCE = 0.07;
const BLADES_DROP_COOLDOWN_SECONDS = 15;
const MAX_SHIELD_CHARGES = 3;
const MAX_HASTE_SECONDS = 8;
const MAX_RAPID_SECONDS = 8;
const BLADES_DURATION_SECONDS = 10;
const BLADE_MAX_DAMAGE = 0.9;

function errorText(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : "";
  if (!message) return fallback;
  if (/user rejected|denied|4001/i.test(message)) return "Transaction rejected in wallet.";
  return `${fallback} ${message.slice(0, 120)}`;
}

function shortAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function dist(aX: number, aY: number, bX: number, bY: number) {
  return Math.hypot(aX - bX, aY - bY);
}

function randomSpawnPoint(width: number, height: number) {
  const side = Math.floor(Math.random() * 4);
  if (side === 0) return { x: Math.random() * width, y: -20 };
  if (side === 1) return { x: width + 20, y: Math.random() * height };
  if (side === 2) return { x: Math.random() * width, y: height + 20 };
  return { x: -20, y: Math.random() * height };
}

function randomBuffType(): BuffType {
  if (Math.random() < 0.03) return "wipe";
  const pool: BuffType[] = ["haste", "rapid", "shield", "blades", "blades"];
  return pool[Math.floor(Math.random() * pool.length)];
}

function randomNonBladeBuffType(): BuffType {
  const v = Math.floor(Math.random() * 3);
  if (v === 0) return "haste";
  if (v === 1) return "rapid";
  return "shield";
}

function xpForNextLevel(level: number) {
  return 40 + level * 30 + level * level * 6;
}

function calcDamage(level: number) {
  return Number((1 + (level - 1) * 0.15).toFixed(2));
}

function calcMaxHp(level: number) {
  return 3 + Math.floor((level - 1) / 2);
}

export default function HomePage() {
  const [phase, setPhase] = useState<Phase>("menu");
  const [account, setAccount] = useState<Address | null>(null);
  const [walletChecked, setWalletChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [timeMs, setTimeMs] = useState(0);
  const [kills, setKills] = useState(0);
  const [wave, setWave] = useState(1);
  const [bestRun, setBestRun] = useState(0);
  const [bestVerifiedRun, setBestVerifiedRun] = useState(0);
  const [lastRunScore, setLastRunScore] = useState(0);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);

  const [level, setLevel] = useState(1);
  const [levelXp, setLevelXp] = useState(0);
  const [nextLevelXp, setNextLevelXp] = useState(xpForNextLevel(1));
  const [damage, setDamage] = useState(calcDamage(1));
  const [maxHp, setMaxHp] = useState(calcMaxHp(1));
  const [currentHp, setCurrentHp] = useState(calcMaxHp(1));

  const [player, setPlayer] = useState({ x: DEFAULT_ARENA_WIDTH / 2, y: DEFAULT_ARENA_HEIGHT / 2 });
  const [enemiesView, setEnemiesView] = useState<Enemy[]>([]);
  const [bulletsView, setBulletsView] = useState<Bullet[]>([]);
  const [buffsView, setBuffsView] = useState<BuffPickup[]>([]);
  const [swordsView, setSwordsView] = useState<SwordView[]>([]);
  const [hasteLeftMs, setHasteLeftMs] = useState(0);
  const [rapidLeftMs, setRapidLeftMs] = useState(0);
  const [bladesLeftMs, setBladesLeftMs] = useState(0);
  const [shieldCharges, setShieldCharges] = useState(0);

  const [provider, setProvider] = useState<EthereumProvider | null>(null);
  const [statusMessage, setStatusMessage] = useState("");

  const runningRef = useRef(false);
  const arenaRef = useRef<HTMLDivElement | null>(null);
  const touchRef = useRef({ x: 0, y: 0, active: false });
  const keyRef = useRef({ x: 0, y: 0 });
  const playerRef = useRef({ x: DEFAULT_ARENA_WIDTH / 2, y: DEFAULT_ARENA_HEIGHT / 2 });
  const arenaSizeRef = useRef({ w: DEFAULT_ARENA_WIDTH, h: DEFAULT_ARENA_HEIGHT });
  const enemiesRef = useRef<Enemy[]>([]);
  const bulletsRef = useRef<Bullet[]>([]);
  const buffsRef = useRef<BuffPickup[]>([]);
  const killRef = useRef(0);
  const timeRef = useRef(0);
  const idRef = useRef(1);
  const shootCdRef = useRef(0.25);
  const spawnCdRef = useRef(1.2);
  const buffSpawnCdRef = useRef(9);
  const graceRef = useRef(1.2);
  const hasteRef = useRef(0);
  const rapidRef = useRef(0);
  const bladesRef = useRef(0);
  const bladesDropCdRef = useRef(0);
  const shieldRef = useRef(0);
  const levelRef = useRef(1);
  const levelXpRef = useRef(0);
  const damageRef = useRef(calcDamage(1));
  const maxHpRef = useRef(calcMaxHp(1));
  const currentHpRef = useRef(calcMaxHp(1));
  const runXpGainedRef = useRef(0);
  const rafIdRef = useRef<number | null>(null);

  const liveScore = Math.floor(timeMs / 1000) + kills * 6 + (wave - 1) * 10;

  const loadLeaderboard = useCallback(async (address?: string) => {
    const url = address ? `/api/leaderboard?address=${encodeURIComponent(address)}` : "/api/leaderboard";
    let res: Response;
    try {
      res = await fetch(url, { cache: "no-store" });
    } catch {
      return;
    }
    if (!res.ok) return;
    const json = (await res.json()) as {
      leaderboard: LeaderboardEntry[];
      profile?: LeaderboardEntry | null;
    };
    setLeaderboard(json.leaderboard ?? []);
    if (json.profile) {
      setBestRun(json.profile.bestScore);
      setBestVerifiedRun(json.profile.verifiedBestScore ?? 0);
      setLastRunScore(json.profile.lastScore);
      const lvl = Math.max(1, json.profile.level ?? 1);
      const xp = Math.max(0, json.profile.levelXp ?? 0);
      levelRef.current = lvl;
      levelXpRef.current = xp;
      damageRef.current = json.profile.damage ?? calcDamage(lvl);
      maxHpRef.current = json.profile.maxHp ?? calcMaxHp(lvl);
      currentHpRef.current = maxHpRef.current;
      setLevel(lvl);
      setLevelXp(xp);
      setNextLevelXp(json.profile.nextLevelXp ?? xpForNextLevel(lvl));
      setDamage(damageRef.current);
      setMaxHp(maxHpRef.current);
      setCurrentHp(currentHpRef.current);
    }
  }, []);

  const syncBuffView = useCallback(() => {
    setHasteLeftMs(Math.max(0, Math.floor(hasteRef.current * 1000)));
    setRapidLeftMs(Math.max(0, Math.floor(rapidRef.current * 1000)));
    setBladesLeftMs(Math.max(0, Math.floor(bladesRef.current * 1000)));
    setShieldCharges(shieldRef.current);
  }, []);

  const submitLeaderboardRun = useCallback(async (addr: string, score: number, verified = false, xpGained = 0) => {
    const res = await fetch("/api/leaderboard", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: addr, score, verified, xpGained })
    });
    if (!res.ok) return;
    const json = (await res.json()) as { leaderboard: LeaderboardEntry[]; profile: LeaderboardEntry };
    setLeaderboard(json.leaderboard ?? []);
    if (json.profile) {
      setBestRun(json.profile.bestScore);
      setBestVerifiedRun(json.profile.verifiedBestScore ?? 0);
      setLastRunScore(json.profile.lastScore);
      const lvl = Math.max(1, json.profile.level ?? 1);
      const xp = Math.max(0, json.profile.levelXp ?? 0);
      levelRef.current = lvl;
      levelXpRef.current = xp;
      damageRef.current = json.profile.damage ?? calcDamage(lvl);
      maxHpRef.current = json.profile.maxHp ?? calcMaxHp(lvl);
      setLevel(lvl);
      setLevelXp(xp);
      setNextLevelXp(json.profile.nextLevelXp ?? xpForNextLevel(lvl));
      setDamage(damageRef.current);
      setMaxHp(maxHpRef.current);
    }
  }, []);

  const gainXp = useCallback((amount: number) => {
    if (amount <= 0) return;
    runXpGainedRef.current += amount;
    let lvl = levelRef.current;
    let xp = levelXpRef.current + amount;
    while (xp >= xpForNextLevel(lvl)) {
      xp -= xpForNextLevel(lvl);
      lvl += 1;
    }
    levelRef.current = lvl;
    levelXpRef.current = xp;
    const dmg = calcDamage(lvl);
    const hp = calcMaxHp(lvl);
    damageRef.current = dmg;
    maxHpRef.current = hp;
    currentHpRef.current = Math.min(currentHpRef.current, hp);
    setLevel(lvl);
    setLevelXp(xp);
    setNextLevelXp(xpForNextLevel(lvl));
    setDamage(dmg);
    setMaxHp(hp);
    setCurrentHp(currentHpRef.current);
  }, []);

  const resetGame = useCallback(() => {
    runningRef.current = false;
    touchRef.current = { x: 0, y: 0, active: false };
    const { w, h } = arenaSizeRef.current;
    playerRef.current = { x: w / 2, y: h / 2 };
    enemiesRef.current = [];
    bulletsRef.current = [];
    buffsRef.current = [];
    killRef.current = 0;
    timeRef.current = 0;
    shootCdRef.current = 0.25;
    spawnCdRef.current = 1.2;
    buffSpawnCdRef.current = 8.5;
    graceRef.current = 1.2;
    hasteRef.current = 0;
    rapidRef.current = 0;
    bladesRef.current = 0;
    bladesDropCdRef.current = 0;
    shieldRef.current = 0;
    runXpGainedRef.current = 0;
    currentHpRef.current = maxHpRef.current;
    setPlayer(playerRef.current);
    setEnemiesView([]);
    setBulletsView([]);
    setBuffsView([]);
    setSwordsView([]);
    setKills(0);
    setTimeMs(0);
    setWave(1);
    setCurrentHp(currentHpRef.current);
    syncBuffView();
  }, [syncBuffView]);

  const endRun = useCallback(() => {
    runningRef.current = false;
    const finalTime = Math.floor(timeRef.current);
    const finalKills = killRef.current;
    const finalWave = Math.max(1, Math.ceil(finalTime / WAVE_MS));
    const finalScore = Math.floor(finalTime / 1000) + finalKills * 6 + (finalWave - 1) * 10;
    setTimeMs(finalTime);
    setKills(finalKills);
    setWave(finalWave);
    setLastRunScore(finalScore);
    setBestRun((v) => Math.max(v, finalScore));
    setPhase("gameover");
    if (account) void submitLeaderboardRun(account, finalScore, false, runXpGainedRef.current);
  }, [account, submitLeaderboardRun]);

  const startGame = useCallback(() => {
    if (!account) {
      return;
    }
    resetGame();
    runningRef.current = true;
    setPhase("playing");
  }, [account, resetGame]);

  const connect = useCallback(async () => {
    if (!provider) {
      setStatusMessage("No wallet provider available in this app.");
      return;
    }
    try {
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as Address[];
      if (!accounts.length) {
        setStatusMessage("Wallet returned no account.");
        return;
      }
      const addr = accounts[0].toLowerCase() as Address;
      setAccount(addr);
      storeWallet(addr);
      setStatusMessage("");
      await loadLeaderboard(addr);
    } catch (error) {
      // An unhandled rejection here left the button looking like it did nothing.
      setStatusMessage(errorText(error, "Could not connect the wallet."));
    }
  }, [loadLeaderboard, provider]);

  useEffect(() => {
    sdk.actions.ready().catch(() => null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const resolveProvider = async () => {
      let resolved: EthereumProvider | null = null;
      try {
        resolved = (await sdk.wallet.getEthereumProvider()) as EthereumProvider | null;
      } catch {
        resolved = null;
      }
      if (!resolved && typeof window !== "undefined") {
        resolved = (window as Window & { ethereum?: EthereumProvider }).ethereum ?? null;
      }
      if (!cancelled) setProvider(resolved);
    };
    void resolveProvider();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void loadLeaderboard();
  }, [loadLeaderboard]);

  useEffect(() => {
    const init = async () => {
      if (!provider) {
        setWalletChecked(true);
        return;
      }
      try {
        const accounts = (await provider.request({ method: "eth_accounts" })) as Address[];
        if (accounts.length) {
          const addr = accounts[0].toLowerCase() as Address;
          setAccount(addr);
          storeWallet(addr);
          await loadLeaderboard(addr);
        }
      } catch {
        // no connected account yet; the connect button covers this
      } finally {
        setWalletChecked(true);
      }
    };
    void init();
  }, [loadLeaderboard, provider]);

  useEffect(() => {
    if (!provider) return;
    const anyProvider = provider as any;
    const onAccountsChanged = (accounts: string[]) => {
      if (!accounts?.length) {
        setAccount(null);
        return;
      }
      const addr = accounts[0].toLowerCase() as Address;
      setAccount(addr);
      storeWallet(addr);
      void loadLeaderboard(addr);
    };
    anyProvider.on?.("accountsChanged", onAccountsChanged);
    return () => anyProvider.removeListener?.("accountsChanged", onAccountsChanged);
  }, [loadLeaderboard, provider]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" || e.key.toLowerCase() === "a") keyRef.current.x = -1;
      if (e.key === "ArrowRight" || e.key.toLowerCase() === "d") keyRef.current.x = 1;
      if (e.key === "ArrowUp" || e.key.toLowerCase() === "w") keyRef.current.y = -1;
      if (e.key === "ArrowDown" || e.key.toLowerCase() === "s") keyRef.current.y = 1;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if ("arrowleft arrowright a d".split(" ").includes(e.key.toLowerCase())) keyRef.current.x = 0;
      if ("arrowup arrowdown w s".split(" ").includes(e.key.toLowerCase())) keyRef.current.y = 0;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  useEffect(() => {
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.04);
      last = now;
      if (runningRef.current && account) {
        if (arenaRef.current) {
          arenaSizeRef.current = {
            w: Math.max(220, arenaRef.current.clientWidth),
            h: Math.max(280, arenaRef.current.clientHeight)
          };
        }
        const arenaW = arenaSizeRef.current.w;
        const arenaH = arenaSizeRef.current.h;

        timeRef.current += dt * 1000;
        const currentWave = Math.max(1, Math.ceil(timeRef.current / WAVE_MS));
        setWave(currentWave);
        setTimeMs(Math.floor(timeRef.current));

        hasteRef.current = Math.max(0, hasteRef.current - dt);
        rapidRef.current = Math.max(0, rapidRef.current - dt);
        bladesRef.current = Math.max(0, bladesRef.current - dt);
        bladesDropCdRef.current = Math.max(0, bladesDropCdRef.current - dt);
        syncBuffView();

        const pickSpawnBuffType = () => {
          const picked = randomBuffType();
          if (picked !== "blades") return picked;
          if (bladesDropCdRef.current > 0) return randomNonBladeBuffType();
          bladesDropCdRef.current = BLADES_DROP_COOLDOWN_SECONDS;
          return "blades";
        };

        const move = touchRef.current.active ? touchRef.current : keyRef.current;
        const moveLen = Math.hypot(move.x, move.y) || 1;
        const speed = 170 * (hasteRef.current > 0 ? 1.45 : 1);
        playerRef.current.x = Math.max(
          PLAYER_RADIUS,
          Math.min(arenaW - PLAYER_RADIUS, playerRef.current.x + (move.x / moveLen) * speed * dt)
        );
        playerRef.current.y = Math.max(
          PLAYER_RADIUS,
          Math.min(arenaH - PLAYER_RADIUS, playerRef.current.y + (move.y / moveLen) * speed * dt)
        );

        spawnCdRef.current -= dt;
        if (spawnCdRef.current <= 0) {
          spawnCdRef.current = Math.max(0.14, 0.85 - (currentWave - 1) * 0.1);
          const spawns = 1 + Math.floor((currentWave - 1) / 3);
          for (let i = 0; i < spawns; i += 1) {
            const p = randomSpawnPoint(arenaW, arenaH);
            const elite = currentWave >= 4 && Math.random() < Math.min(0.45, 0.08 * currentWave);
            enemiesRef.current.push({
              id: idRef.current++,
              x: p.x,
              y: p.y,
              r: elite ? ENEMY_RADIUS + 3 : ENEMY_RADIUS,
              speed: 34 + currentWave * 5 + Math.random() * 24,
              hp: elite ? 2 : 1,
              bladeCd: 0
            });
          }
        }

        buffSpawnCdRef.current -= dt;
        if (buffSpawnCdRef.current <= 0) {
          buffSpawnCdRef.current = 7 + Math.random() * 3;
          buffsRef.current.push({
            id: idRef.current++,
            x: 36 + Math.random() * Math.max(1, arenaW - 72),
            y: 36 + Math.random() * Math.max(1, arenaH - 72),
            type: pickSpawnBuffType(),
            life: 10
          });
        }

        shootCdRef.current -= dt;
        if (shootCdRef.current <= 0) {
          const levelFireBonus = Math.min(0.12, (levelRef.current - 1) * 0.004);
          const baseInterval = Math.max(0.16, 0.28 - levelFireBonus);
          const rapidInterval = Math.max(0.1, baseInterval * 0.58);
          shootCdRef.current = rapidRef.current > 0 ? rapidInterval : baseInterval;
          let nearest: Enemy | null = null;
          let nearestDist = Infinity;
          for (const e of enemiesRef.current) {
            const d = dist(e.x, e.y, playerRef.current.x, playerRef.current.y);
            if (d < nearestDist) {
              nearest = e;
              nearestDist = d;
            }
          }
          if (nearest) {
            const tx = nearest.x - playerRef.current.x;
            const ty = nearest.y - playerRef.current.y;
            const l = Math.hypot(tx, ty) || 1;
            const levelSpeedBonus = Math.min(180, (levelRef.current - 1) * 6);
            const bulletSpeed = 320 + levelSpeedBonus;
            bulletsRef.current.push({
              id: idRef.current++,
              x: playerRef.current.x,
              y: playerRef.current.y,
              vx: (tx / l) * bulletSpeed,
              vy: (ty / l) * bulletSpeed,
              life: 1.1
            });
          }
        }

        for (const e of enemiesRef.current) {
          e.bladeCd = Math.max(0, e.bladeCd - dt);
          const tx = playerRef.current.x - e.x;
          const ty = playerRef.current.y - e.y;
          const l = Math.hypot(tx, ty) || 1;
          e.x += (tx / l) * e.speed * dt;
          e.y += (ty / l) * e.speed * dt;
        }

        for (const b of bulletsRef.current) {
          b.x += b.vx * dt;
          b.y += b.vy * dt;
          b.life -= dt;
        }

        for (const buff of buffsRef.current) {
          buff.life -= dt;
          const d = dist(buff.x, buff.y, playerRef.current.x, playerRef.current.y);
          if (d < BUFF_MAGNET_RADIUS) {
            const strength = 0.35 + (1 - d / BUFF_MAGNET_RADIUS) * 1.45;
            buff.x += ((playerRef.current.x - buff.x) / (d || 1)) * BUFF_MAGNET_SPEED * strength * dt;
            buff.y += ((playerRef.current.y - buff.y) / (d || 1)) * BUFF_MAGNET_SPEED * strength * dt;
          }
        }

        bulletsRef.current = bulletsRef.current.filter(
          (b) => b.life > 0 && b.x > -24 && b.x < arenaW + 24 && b.y > -24 && b.y < arenaH + 24
        );
        buffsRef.current = buffsRef.current.filter((b) => b.life > 0);

        const removeEnemy = new Set<number>();
        const removeBullet = new Set<number>();
        const killsBefore = killRef.current;

        for (const b of bulletsRef.current) {
          for (const e of enemiesRef.current) {
            if (removeEnemy.has(e.id)) continue;
            if (dist(b.x, b.y, e.x, e.y) < BULLET_RADIUS + e.r) {
              e.hp -= damageRef.current;
              removeBullet.add(b.id);
              if (e.hp <= 0) {
                removeEnemy.add(e.id);
                killRef.current += 1;
                if (Math.random() < BUFF_DROP_CHANCE) {
                  buffsRef.current.push({
                    id: idRef.current++,
                    x: e.x,
                    y: e.y,
                    type: pickSpawnBuffType(),
                    life: 10
                  });
                }
              }
            }
          }
        }

        if (bladesRef.current > 0) {
          const swords: SwordView[] = [];
          const bladesCount = 3;
          const bladeRadius = 38;
          const bladeHitRadius = 11;
          const angleBase = timeRef.current * 0.012;
          for (let i = 0; i < bladesCount; i += 1) {
            const angle = angleBase + (Math.PI * 2 * i) / bladesCount;
            const sx = playerRef.current.x + Math.cos(angle) * bladeRadius;
            const sy = playerRef.current.y + Math.sin(angle) * bladeRadius;
            swords.push({ id: i, x: sx, y: sy });
            for (const e of enemiesRef.current) {
              if (e.bladeCd > 0) continue;
              if (dist(sx, sy, e.x, e.y) < bladeHitRadius + e.r) {
                const bladeDamage = Math.min(BLADE_MAX_DAMAGE, damageRef.current * 0.55);
                e.hp -= bladeDamage;
                e.bladeCd = 0.18;
                if (e.hp <= 0) {
                  removeEnemy.add(e.id);
                  killRef.current += 1;
                  if (Math.random() < BUFF_DROP_CHANCE) {
                    buffsRef.current.push({
                      id: idRef.current++,
                      x: e.x,
                      y: e.y,
                      type: pickSpawnBuffType(),
                      life: 10
                    });
                  }
                }
              }
            }
          }
          setSwordsView(swords);
        } else {
          setSwordsView([]);
        }

        if (removeEnemy.size > 0 || removeBullet.size > 0) {
          enemiesRef.current = enemiesRef.current.filter((e) => !removeEnemy.has(e.id));
          bulletsRef.current = bulletsRef.current.filter((b) => !removeBullet.has(b.id));
          setKills(killRef.current);
          const killedNow = Math.max(0, killRef.current - killsBefore);
          if (killedNow > 0) gainXp(killedNow * (8 + currentWave));
        }

        for (const buff of buffsRef.current) {
          if (dist(buff.x, buff.y, playerRef.current.x, playerRef.current.y) < BUFF_RADIUS + PLAYER_RADIUS) {
            if (buff.type === "haste") {
              hasteRef.current = Math.min(MAX_HASTE_SECONDS, hasteRef.current + 2.2);
            }
            if (buff.type === "rapid") {
              rapidRef.current = Math.min(MAX_RAPID_SECONDS, rapidRef.current + 2.2);
            }
            if (buff.type === "shield") {
              shieldRef.current = Math.min(MAX_SHIELD_CHARGES, shieldRef.current + 1);
            }
            if (buff.type === "blades") {
              bladesRef.current = BLADES_DURATION_SECONDS;
            }
            if (buff.type === "wipe") {
              const wiped = enemiesRef.current.length;
              if (wiped > 0) {
                killRef.current += wiped;
                setKills(killRef.current);
                gainXp(wiped * (8 + currentWave));
                enemiesRef.current = [];
                setEnemiesView([]);
              }
            }
            buffsRef.current = buffsRef.current.filter((v) => v.id !== buff.id);
            syncBuffView();
          }
        }

        graceRef.current -= dt;
        if (graceRef.current <= 0) {
          let hitEnemy: Enemy | null = null;
          for (const e of enemiesRef.current) {
            if (dist(e.x, e.y, playerRef.current.x, playerRef.current.y) < e.r + PLAYER_RADIUS) {
              hitEnemy = e;
              break;
            }
          }
          if (hitEnemy) {
            if (shieldRef.current > 0) {
              shieldRef.current -= 1;
              graceRef.current = 0.5;
              syncBuffView();
            } else {
              currentHpRef.current = Math.max(0, currentHpRef.current - 1);
              setCurrentHp(currentHpRef.current);
              graceRef.current = 0.5;
              if (currentHpRef.current <= 0) endRun();
            }
          }
        }

        setPlayer({ ...playerRef.current });
        setEnemiesView([...enemiesRef.current]);
        setBulletsView([...bulletsRef.current]);
        setBuffsView([...buffsRef.current]);
      }
      rafIdRef.current = requestAnimationFrame(loop);
    };
    rafIdRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, [account, endRun, gainXp, syncBuffView]);

  const submitOnchain = useCallback(async () => {
    if (!provider || !account) {
      setStatusMessage("Connect a wallet before submitting a score.");
      return;
    }
    if (lastRunScore <= 0) {
      setStatusMessage("Finish a run first.");
      return;
    }
    setSubmitting(true);
    setStatusMessage("");
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] });
      // The score belongs in GaslessScoreGame.submitScore(); the old call was a
      // self-transfer of `score` wei, so nothing ever reached the contract and
      // the "verified" column could never mean anything.
      const contractAddress = getGameContractAddress();
      const call = contractAddress
        ? {
            to: contractAddress,
            value: "0x0",
            data: encodeFunctionData({
              abi: gameAbi,
              functionName: "submitScore",
              args: [BigInt(lastRunScore)]
            })
          }
        : { to: account, value: `0x${BigInt(Math.max(1, lastRunScore)).toString(16)}` };
      let txHash: string | null = null;
      let sentViaSendCalls = false;
      let primaryError = "";
      try {
        const baseCall = {
          version: "2.0.0",
          chainId: CHAIN_ID_HEX,
          from: account,
          atomicRequired: false,
          calls: [call]
        };
        let sendResult: any = null;
        try {
          sendResult = await provider.request({
            method: "wallet_sendCalls",
            params: [
              {
                ...baseCall,
                capabilities: {
                  dataSuffix: {
                    value: DATA_SUFFIX,
                    optional: true
                  }
                }
              }
            ]
          });
        } catch {
          try {
            sendResult = await provider.request({
              method: "wallet_sendCalls",
              params: [
                {
                  ...baseCall,
                  capabilities: {
                    dataSuffix: DATA_SUFFIX
                  }
                }
              ]
            });
          } catch {
            sendResult = await provider.request({
              method: "wallet_sendCalls",
              params: [baseCall]
            });
          }
        }
        if (typeof sendResult === "string") {
          // Wallet may return a call id instead of tx hash. Treat as accepted.
          sentViaSendCalls = true;
        } else if (sendResult?.transactionHash) {
          txHash = sendResult.transactionHash;
          sentViaSendCalls = true;
        } else if (sendResult) {
          // Some wallets return an object without transactionHash.
          sentViaSendCalls = true;
        }
      } catch (error) {
        primaryError = error instanceof Error ? error.message : "wallet_sendCalls failed";
      }
      // Only fallback if wallet_sendCalls was not accepted at all.
      if (!txHash && !sentViaSendCalls) {
        try {
          txHash = (await provider.request({
            method: "eth_sendTransaction",
            params: [{ from: account, ...call }]
          })) as string;
        } catch (error) {
          const fallbackError = error instanceof Error ? error.message : "eth_sendTransaction failed";
          throw new Error(
            `Could not send onchain score tx. wallet_sendCalls: ${primaryError || "n/a"}. eth_sendTransaction: ${fallbackError}`
          );
        }
      }
      await submitLeaderboardRun(account, lastRunScore, true, 0);
      setStatusMessage(
        contractAddress
          ? "Score submitted onchain. The verified column updates once the tx is mined."
          : "Transaction sent. Set NEXT_PUBLIC_GAME_CONTRACT_ADDRESS to record scores in the contract."
      );
    } catch (error) {
      setStatusMessage(errorText(error, "Could not submit the score onchain."));
    } finally {
      setSubmitting(false);
    }
  }, [account, lastRunScore, provider, submitLeaderboardRun]);

  const updateTouchMove = useCallback((clientX: number, clientY: number) => {
    const arena = arenaRef.current;
    if (!arena) return;
    const rect = arena.getBoundingClientRect();
    const dx = clientX - rect.left - playerRef.current.x;
    const dy = clientY - rect.top - playerRef.current.y;
    const len = Math.hypot(dx, dy);
    touchRef.current =
      len < 8
        ? { x: 0, y: 0, active: true }
        : {
            x: Math.max(-1, Math.min(1, dx / len)),
            y: Math.max(-1, Math.min(1, dy / len)),
            active: true
          };
  }, []);

  const onArenaTouchStart = useCallback((e: TouchEvent<HTMLDivElement>) => {
    e.preventDefault();
    const t = e.touches[0];
    if (t) updateTouchMove(t.clientX, t.clientY);
  }, [updateTouchMove]);

  const onArenaTouchMove = useCallback((e: TouchEvent<HTMLDivElement>) => {
    e.preventDefault();
    const t = e.touches[0];
    if (t) updateTouchMove(t.clientX, t.clientY);
  }, [updateTouchMove]);

  const onArenaTouchEnd = useCallback(() => {
    touchRef.current = { x: 0, y: 0, active: false };
  }, []);

  useEffect(() => {
    const arena = arenaRef.current;
    if (!arena) return;
    const blockDefault = (event: Event) => event.preventDefault();
    arena.addEventListener("contextmenu", blockDefault);
    arena.addEventListener("selectstart", blockDefault);
    arena.addEventListener("touchstart", blockDefault, { passive: false });
    arena.addEventListener("touchmove", blockDefault, { passive: false });
    return () => {
      arena.removeEventListener("contextmenu", blockDefault);
      arena.removeEventListener("selectstart", blockDefault);
      arena.removeEventListener("touchstart", blockDefault);
      arena.removeEventListener("touchmove", blockDefault);
    };
  }, [phase]);

  const activeBuffs = [
    hasteLeftMs > 0 ? `Haste ${Math.ceil(hasteLeftMs / 1000)}s` : null,
    rapidLeftMs > 0 ? `Rapid ${Math.ceil(rapidLeftMs / 1000)}s` : null,
    bladesLeftMs > 0 ? `Blades ${Math.ceil(bladesLeftMs / 1000)}s` : null,
    shieldCharges > 0 ? `Shield x${shieldCharges}` : null
  ].filter(Boolean) as string[];

  return (
    <main className={`page ${phase === "playing" ? "playing" : ""}`}>
      <section className="card">
        <header className="top">
          <h1>Pragma</h1>
        </header>

        {phase !== "playing" && (
          <>
            {!walletChecked || !account ? (
              <div className="menu-actions">
                <button className="primary big" onClick={connect}>Connect Wallet To Play</button>
                {statusMessage && <p className="status">{statusMessage}</p>}
              </div>
            ) : (
              <>
                <p className="muted">Wallet: {shortAddress(account)}. Progress is tied to this address.</p>
                <div className="menu-stats">
                  <div className="menu-stat"><span>Level</span><strong>{level}</strong></div>
                  <div className="menu-stat"><span>XP</span><strong>{levelXp}/{nextLevelXp}</strong></div>
                  <div className="menu-stat"><span>Damage</span><strong>{damage.toFixed(2)}</strong></div>
                  <div className="menu-stat"><span>HP</span><strong>{maxHp}</strong></div>
                  <div className="menu-stat"><span>Best</span><strong>{bestRun}</strong></div>
                  <div className="menu-stat"><span>Verified</span><strong>{bestVerifiedRun}</strong></div>
                  <div className="menu-stat"><span>Last</span><strong>{lastRunScore}</strong></div>
                  <div className="menu-stat"><span>Wave</span><strong>{wave}</strong></div>
                </div>
                <div className="menu-actions">
                  <button className="primary big" onClick={startGame}>Start Run</button>
                  <button className="primary big checkin-btn" onClick={submitOnchain} disabled={submitting}>
                    {submitting ? "Submitting..." : "Submit Onchain Score"}
                  </button>
                </div>
                {statusMessage && <p className="status">{statusMessage}</p>}
              </>
            )}

            <div className="leaderboard">
              <p className="lb-title">Leaderboard</p>
              {leaderboard.length === 0 ? (
                <p className="lb-empty">No entries yet.</p>
              ) : (
                leaderboard.slice(0, 10).map((entry, idx) => (
                  <div
                    key={`${entry.address}-${entry.updatedAt}`}
                    className={`lb-row ${account?.toLowerCase() === entry.address.toLowerCase() ? "me" : ""}`}
                  >
                    <span>{idx + 1}. {shortAddress(entry.address)} Lv.{entry.level}</span>
                    <strong className="lb-score">
                      <b className="verified">{entry.verifiedBestScore}</b>
                      <i>{entry.bestScore}</i>
                    </strong>
                  </div>
                ))
              )}
            </div>
          </>
        )}

        {phase === "playing" && (
          <>
            <div className="hud-live">
              <span>{(timeMs / 1000).toFixed(1)}s</span>
              <span>Wave {wave}</span>
              <span>HP {currentHp}/{maxHp}</span>
              <span>Kills {kills}</span>
              <span>Score {liveScore}</span>
            </div>
            <div className="buff-row">
              {activeBuffs.length ? activeBuffs.map((b) => <span key={b}>{b}</span>) : <span>No Buff</span>}
            </div>
            <div className="arena">
              <div
                ref={arenaRef}
                className="arena-touch"
                onTouchStart={onArenaTouchStart}
                onTouchMove={onArenaTouchMove}
                onTouchEnd={onArenaTouchEnd}
                onTouchCancel={onArenaTouchEnd}
                onContextMenu={(e) => e.preventDefault()}
              />
              <div className="player" style={{ left: player.x - PLAYER_RADIUS, top: player.y - PLAYER_RADIUS }} />
              {enemiesView.map((e) => (
                <div
                  key={e.id}
                  className={`enemy ${e.hp > 1 ? "elite" : ""}`}
                  style={{ left: e.x - e.r, top: e.y - e.r, width: e.r * 2, height: e.r * 2 }}
                />
              ))}
              {bulletsView.map((b) => (
                <div
                  key={b.id}
                  className="bullet"
                  style={{ left: b.x - BULLET_RADIUS, top: b.y - BULLET_RADIUS, width: BULLET_RADIUS * 2, height: BULLET_RADIUS * 2 }}
                />
              ))}
              {swordsView.map((s) => (
                <div key={s.id} className="sword" style={{ left: s.x - 5, top: s.y - 14 }} />
              ))}
              {buffsView.map((b) => (
                <div
                  key={b.id}
                  className={`buff ${b.type}`}
                  data-buff={b.type}
                  style={{ left: b.x - BUFF_RADIUS, top: b.y - BUFF_RADIUS, width: BUFF_RADIUS * 2, height: BUFF_RADIUS * 2 }}
                />
              ))}
            </div>
          </>
        )}

      </section>
    </main>
  );
}
