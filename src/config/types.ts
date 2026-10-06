import type { Address } from "viem";

export type Environment = "testnet" | "mainnet";

/**
 * How a getLogs block-range value was established.
 *  - observed-limit:   an RPC error message stated this limit.
 *  - observed-working: a request of this size succeeded; the real limit may be higher.
 *  - assumed:          never tested; deliberately conservative. The log fetcher must still
 *                      shrink the window and retry when the RPC rejects a range.
 */
export type RangeEvidence = "observed-limit" | "observed-working" | "assumed";

export interface RpcEndpoint {
  url: string;
  /** Max blocks per eth_getLogs request to use against this endpoint. */
  getLogsMaxRange: number;
  rangeEvidence: RangeEvidence;
  /** The endpoint prunes history before this block (queries below it fail). */
  earliestBlock?: number;
}

/** Contract set published by the gateway's GET /v1/defaults for a chain. */
export interface ContractSet {
  escrow: Address;
  fulfillmentProxy: Address;
  quoteSelector: Address;
  /** `fulfillment_verifier.account` from /v1/defaults. */
  fulfillmentVerifier: Address;
}

export interface NetworkConfig extends ContractSet {
  /** CAIP-2 id, e.g. "eip155:84532". */
  caip2: string;
  chainId: number;
  name: string;
  environment: Environment;
  /** Mainnet entries are experimental: no mainnet settlement has been analysed. */
  experimental: boolean;
  /** Public endpoints, tried in order. May be empty (then an env override is required). */
  rpcs: readonly RpcEndpoint[];
  /** Where the contract addresses and limits came from. */
  provenance: string;
}
