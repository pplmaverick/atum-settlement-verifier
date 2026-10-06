import { keccak256, toBytes, type Address, type Hex } from "viem";

/**
 * x402 request_id, as observed in one cross-chain sample (see README, "Known limits"):
 *   "req_x402_" + first 24 hex chars of keccak256("atum-request:v1:" + purchaseId + ":" + lower(payer))
 * The MPP and PGC paths may differ; this is only claimed for x402.
 */
export function deriveX402RequestId(purchaseId: string, payer: Address): string {
  const digest = keccak256(toBytes(`atum-request:v1:${purchaseId}:${payer.toLowerCase()}`));
  return `req_x402_${digest.slice(2, 26)}`;
}

/** depositRequestHash committed on-chain: keccak256(utf8(request_id)). */
export function depositRequestHashOf(requestId: string): Hex {
  return keccak256(toBytes(requestId));
}

/**
 * Destination commitment string for EVM destinations: "<caip2>/erc20:<asset>@<account>", both lowercased.
 * Only the "erc20" asset namespace and eip155 destinations have been observed.
 */
export function destinationString(destNetwork: string, destAsset: Address, destAddress: Address): string {
  return `${destNetwork}/erc20:${destAsset.toLowerCase()}@${destAddress.toLowerCase()}`;
}

export function destinationHashOf(destNetwork: string, destAsset: Address, destAddress: Address): Hex {
  return keccak256(toBytes(destinationString(destNetwork, destAsset, destAddress)));
}
