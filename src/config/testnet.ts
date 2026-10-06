import type { ContractSet, NetworkConfig } from "./types.js";

/**
 * Testnet contract set, shared by every EVM testnet (value supplied from the testnet gateway's
 * GET /v1/defaults on 2026-10-06). The same addresses were observed in logs and bytecode on Base
 * Sepolia and Tempo Moderato, and the escrow and proxy are source-verified on Base Sepolia and
 * Arbitrum Sepolia. Re-check against /v1/defaults before relying on them: the gateway is the
 * source of truth, this file is a snapshot.
 */
const TESTNET_CONTRACTS: ContractSet = {
  escrow: "0x0F875601504C9179562506AFa34b2D084268869b",
  fulfillmentProxy: "0x1F1F8FA642bc5F530ba37F1Db3a656E9eB8BaFeb",
  quoteSelector: "0xd0f080E23F95571D26eEb1FAD24a5F3d66835195",
  fulfillmentVerifier: "0x27050EE47befC43F4dF7807a7AA8073039e5fa89",
};

const PROVENANCE =
  "Contract addresses: testnet GET /v1/defaults as supplied 2026-10-06 (snapshot). " +
  "RPC limits: see each endpoint's rangeEvidence.";

export const TESTNET_NETWORKS: readonly NetworkConfig[] = [
  {
    ...TESTNET_CONTRACTS,
    caip2: "eip155:84532",
    chainId: 84532,
    name: "Base Sepolia",
    environment: "testnet",
    experimental: false,
    rpcs: [
      // Error message stated "exceed maximum block range: 50000".
      { url: "https://base-sepolia-rpc.publicnode.com", getLogsMaxRange: 50_000, rangeEvidence: "observed-limit" },
      // Error message stated "eth_getLogs is limited to a 500 range"; history pruned below 46,000,000.
      { url: "https://sepolia.base.org", getLogsMaxRange: 500, rangeEvidence: "observed-limit", earliestBlock: 46_000_000 },
    ],
    provenance: PROVENANCE,
  },
  {
    ...TESTNET_CONTRACTS,
    caip2: "eip155:421614",
    chainId: 421614,
    name: "Arbitrum Sepolia",
    environment: "testnet",
    experimental: false,
    rpcs: [
      // Used for receipts and transactions in the sample analysis; its getLogs limit was never tested.
      { url: "https://sepolia-rollup.arbitrum.io/rpc", getLogsMaxRange: 1_000, rangeEvidence: "assumed" },
    ],
    provenance: PROVENANCE,
  },
  {
    ...TESTNET_CONTRACTS,
    caip2: "eip155:42431",
    chainId: 42431,
    name: "Tempo Moderato",
    environment: "testnet",
    experimental: false,
    rpcs: [
      // A 5,000-block window succeeded; the real limit may be higher.
      { url: "https://rpc.moderato.tempo.xyz", getLogsMaxRange: 5_000, rangeEvidence: "observed-working" },
    ],
    provenance: PROVENANCE + " Tempo corridors are access-gated per Atum's docs; no Tempo settlement has been analysed here.",
  },
];
