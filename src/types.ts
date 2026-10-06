/**
 * Result vocabulary. The tool is fail-closed: `pass` is only ever produced when the
 * data was fetched, parsed, and compared successfully. Anything else is one of the
 * other three states, never a silent pass.
 */
import type { EvidenceLevel } from "./checks.js";

export type CheckStatus = "pass" | "fail" | "unknown" | "unsupported";

export interface CheckResult {
  /** Stable id, see src/checks.ts (V1..V14). */
  id: string;
  description: string;
  status: CheckStatus;
  /** How much real-world evidence backs this check's logic (not whether it passed). */
  support: EvidenceLevel;
  /** Human-readable reason, including the compared values where useful. */
  detail: string;
  /** Raw values that were compared, for the JSON output. */
  evidence?: Record<string, string>;
  /** CLI flags that were not given and, if given, would let this check run. Only set on "unknown" results. */
  needs?: string[];
}

export type OverallVerdict =
  /** Every check passed. Still limited by what the tool verifies (see README). */
  | "pass"
  /** At least one check failed. */
  | "fail"
  /** No failure, but at least one check is unknown or unsupported. */
  | "inconclusive";

export interface VerificationSummary {
  pass: number;
  fail: number;
  unknown: number;
  unsupported: number;
}

/**
 * `fail` wins; otherwise anything not `pass` makes the verdict inconclusive. A report with no
 * checks at all is inconclusive, never a pass.
 */
export function overallVerdict(summary: VerificationSummary): OverallVerdict {
  if (summary.fail > 0) return "fail";
  if (summary.pass + summary.unknown + summary.unsupported === 0) return "inconclusive";
  if (summary.unknown > 0 || summary.unsupported > 0) return "inconclusive";
  return "pass";
}

export function summarize(checks: readonly CheckResult[]): VerificationSummary {
  const s: VerificationSummary = { pass: 0, fail: 0, unknown: 0, unsupported: 0 };
  for (const c of checks) s[c.status] += 1;
  return s;
}
