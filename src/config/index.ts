import { MAINNET_NETWORKS } from "./mainnet.js";
import { TESTNET_NETWORKS } from "./testnet.js";
import type { NetworkConfig, RpcEndpoint } from "./types.js";

export type { ContractSet, Environment, NetworkConfig, RangeEvidence, RpcEndpoint } from "./types.js";

export const ALL_NETWORKS: readonly NetworkConfig[] = [...TESTNET_NETWORKS, ...MAINNET_NETWORKS];

/** Range used when an RPC URL is overridden without a matching ATUM_VERIFY_LOG_RANGE_<id>. */
export const OVERRIDE_DEFAULT_RANGE = 500;

export interface ResolvedNetwork extends Omit<NetworkConfig, "rpcs"> {
  rpcs: readonly RpcEndpoint[];
  /** True when the endpoint list came from an environment override. */
  rpcOverridden: boolean;
}

type Env = Readonly<Record<string, string | undefined>>;

function positiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw.trim())) return undefined;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * Look up a network by CAIP-2 id and apply environment overrides:
 *   ATUM_VERIFY_RPC_<chainId>        replaces the endpoint list with this one URL
 *   ATUM_VERIFY_LOG_RANGE_<chainId>  getLogs window for that URL (default 500 when overridden)
 * Returns undefined for chains that are not configured (the caller reports "unsupported").
 * An invalid ATUM_VERIFY_LOG_RANGE value is ignored rather than trusted.
 */
export function resolveNetwork(caip2: string, env: Env = process.env): ResolvedNetwork | undefined {
  const base = ALL_NETWORKS.find((n) => n.caip2 === caip2.trim().toLowerCase());
  if (!base) return undefined;

  const url = env[`ATUM_VERIFY_RPC_${base.chainId}`]?.trim();
  const range = positiveInt(env[`ATUM_VERIFY_LOG_RANGE_${base.chainId}`]);

  if (url) {
    return {
      ...base,
      rpcs: [{ url, getLogsMaxRange: range ?? OVERRIDE_DEFAULT_RANGE, rangeEvidence: "assumed" }],
      rpcOverridden: true,
    };
  }
  if (range !== undefined) {
    return {
      ...base,
      rpcs: base.rpcs.map((r) => ({ ...r, getLogsMaxRange: Math.min(r.getLogsMaxRange, range) })),
      rpcOverridden: false,
    };
  }
  return { ...base, rpcOverridden: false };
}
