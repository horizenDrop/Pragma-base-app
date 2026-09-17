import { createPublicClient, http, isAddress, type Address } from "viem";
import { base } from "viem/chains";
import { gameAbi } from "./gameAbi";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function getGameContractAddress(): Address | null {
  const raw = String(process.env.NEXT_PUBLIC_GAME_CONTRACT_ADDRESS ?? "").trim();
  if (!raw || !isAddress(raw)) return null;
  if (raw.toLowerCase() === ZERO_ADDRESS) return null;
  return raw as Address;
}

export function getRpcUrl() {
  return String(process.env.NEXT_PUBLIC_BASE_RPC_URL ?? "").trim() || "https://mainnet.base.org";
}

function createClient() {
  return createPublicClient({ chain: base, transport: http(getRpcUrl()) });
}

let cachedClient: ReturnType<typeof createClient> | null = null;

function getPublicClient() {
  const client = cachedClient ?? createClient();
  cachedClient = client;
  return client;
}

/**
 * Reads the player's best score straight from the game contract. Returns null
 * when no contract is configured or the call fails, so callers can tell
 * "unverifiable" apart from "verified zero".
 */
export async function readOnchainBestScore(address: string): Promise<number | null> {
  const contract = getGameContractAddress();
  if (!contract || !isAddress(address)) return null;

  try {
    const result = await getPublicClient().readContract({
      address: contract,
      abi: gameAbi,
      functionName: "bestScore",
      args: [address as Address]
    });
    const value = Number(result);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}
