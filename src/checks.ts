/**
 * Catalogue of checks. Ids follow Appendix A of the research notes (spec/verifier-research.md).
 * `support` records how much evidence backs each check today; it is shown in the output so a
 * "pass" is never read as stronger than the evidence behind it.
 */
export type EvidenceLevel =
  /** Observed on one real cross-chain sample (sample 001). */
  | "one-cross-chain-sample"
  /** Observed on one or more same-chain or partial samples only. */
  | "partial-sample"
  /** Derived from published contract source/ABI, never observed on a real payment. */
  | "abi-only"
  /** Not observed and not derivable; the tool reports it as unsupported or unknown. */
  | "none";

export interface CheckSpec {
  id: string;
  description: string;
  support: EvidenceLevel;
}

export const CHECKS: readonly CheckSpec[] = [
  { id: "V1", description: "Source tx emitted Deposited from the configured escrow", support: "one-cross-chain-sample" },
  { id: "V2", description: "Deposited.token equals the expected source asset and the payer's Transfer to escrow matches amount", support: "one-cross-chain-sample" },
  { id: "V3", description: "Deposited.amount <= FULFILLMENT_AMOUNT * (10000 + MARKUP_BPS) / 10000 (a spend cap, not an exact price)", support: "one-cross-chain-sample" },
  { id: "V4", description: "Deposited.reserver / releaser equal the configured quote_selector / fulfillment_verifier", support: "one-cross-chain-sample" },
  { id: "V5", description: "DepositCommitments.destinationHash equals keccak256(lower(dest CAIP-19 asset) + '@' + lower(dest address))", support: "one-cross-chain-sample" },
  { id: "V6", description: "DepositCommitments.depositRequestHash equals keccak256(request_id) derived from purchase id and payer (x402 only)", support: "one-cross-chain-sample" },
  { id: "V6b", description: "The payment id equals Deposited.depositId", support: "one-cross-chain-sample" },
  { id: "V7", description: "Destination proxy emitted Fulfilled with the same quoteHash as Deposited", support: "one-cross-chain-sample" },
  { id: "V8", description: "Fulfilled.to, token and amount equal the expected destination address, asset and amount", support: "one-cross-chain-sample" },
  { id: "V9", description: "Destination tx contains an ERC20 Transfer to the recipient matching Fulfilled", support: "one-cross-chain-sample" },
  { id: "V10", description: "Deposited.settler equals Fulfilled.settler", support: "one-cross-chain-sample" },
  { id: "V11", description: "Released exists for the depositId and the settler received amount - feeAmount", support: "one-cross-chain-sample" },
  { id: "V12", description: "No Refunded event for the depositId (only within the scanned block range)", support: "partial-sample" },
  { id: "V13", description: "Time order: Deposited <= Fulfilled <= Released", support: "one-cross-chain-sample" },
  { id: "V14", description: "Batch (*Many) events: detected and reported; their contents are not verified", support: "none" },
] as const;
