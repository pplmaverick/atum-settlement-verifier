import type { ContractSet, NetworkConfig } from "./types.js";

/**
 * EXPERIMENTAL: no mainnet settlement sample exists. These entries come only from the mainnet
 * gateway's GET /v1/defaults (fetched 2026-10-06) and from bytecode/source-verification lookups.
 * Every result produced against a mainnet entry is labelled experimental by the verifier.
 *
 * The gateway returned the same escrow, proxy and quote_selector for all EVM chains it listed
 * (eip155:1, 10, 137, 42161, 4217, 42220, 43114, 8453). Only chains with a usable public RPC
 * are configured below; add others via an env override plus a config entry.
 */
const MAINNET_CONTRACTS: ContractSet = {
  escrow: "0x815d450F443466d52D3c1fB7a57D74D463D1E6F0",
  fulfillmentProxy: "0xA8F40Ed7437BCB6bF264832369e8364b80B06c83",
  quoteSelector: "0xA8062A58adBF640D4eA994da355C124F5866720C",
  fulfillmentVerifier: "0x27050EE47befC43F4dF7807a7AA8073039e5fa89",
};

const PROVENANCE =
  "EXPERIMENTAL: no mainnet sample. Contract addresses from production-mainnet GET /v1/defaults 2026-10-06 (snapshot). " +
  "getLogs range values are assumptions, not observations.";

export const MAINNET_NETWORKS: readonly NetworkConfig[] = [
  {
    ...MAINNET_CONTRACTS,
    caip2: "eip155:8453",
    chainId: 8453,
    name: "Base",
    environment: "mainnet",
    experimental: true,
    rpcs: [{ url: "https://mainnet.base.org", getLogsMaxRange: 500, rangeEvidence: "assumed" }],
    provenance: PROVENANCE,
  },
  {
    ...MAINNET_CONTRACTS,
    caip2: "eip155:42161",
    chainId: 42161,
    name: "Arbitrum One",
    environment: "mainnet",
    experimental: true,
    rpcs: [{ url: "https://arb1.arbitrum.io/rpc", getLogsMaxRange: 1_000, rangeEvidence: "assumed" }],
    provenance: PROVENANCE,
  },
  {
    ...MAINNET_CONTRACTS,
    caip2: "eip155:4217",
    chainId: 4217,
    name: "Tempo",
    environment: "mainnet",
    experimental: true,
    // No public RPC is configured: set ATUM_VERIFY_RPC_4217. Without it the verifier reports "unsupported".
    rpcs: [],
    provenance: PROVENANCE + " No default RPC configured.",
  },
];
