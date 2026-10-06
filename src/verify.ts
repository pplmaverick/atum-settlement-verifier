import { isAddress, type Address, type Hex } from "viem";
import { CHECKS } from "./checks.js";
import { resolveNetwork, type ResolvedNetwork } from "./config/index.js";
import { addrEq, decodeLog, hexEq, isBatchKind, topic0, type Decoded } from "./decode.js";
import { depositRequestHashOf, deriveX402RequestId, destinationHashOf, destinationString } from "./derive.js";
import { createReader, type ChainReader, type RawLog, type RawReceipt, type ReaderOptions } from "./rpc.js";
import { overallVerdict, summarize, type CheckResult, type CheckStatus, type OverallVerdict, type VerificationSummary } from "./types.js";

export const TOOL_NAME = "atum-settlement-verifier";
export const TOOL_VERSION = "0.0.1";
export const DISCLAIMER =
  "Unofficial, read-only tool; not affiliated with Atum. Its logic was checked against one cross-chain sample. " +
  "A pass means the listed checks held for this payment on the data the RPC returned; it is not a security guarantee.";

export class InputError extends Error {}

export interface VerifyInput {
  sourceNetwork: string;
  destNetwork: string;
  /** One of paymentId / sourceTx is required. For x402 EVM the payment id equals the escrow depositId. */
  paymentId?: Hex;
  sourceTx?: Hex;
  /** Optional: skip the destination search by naming the destination tx. */
  destTx?: Hex;
  destAddress: Address;
  destAsset: Address;
  /** FULFILLMENT_AMOUNT in the destination token's atomic units. */
  amount: bigint;
  markupBps?: bigint;
  /** Optional: expected source token (V2). Without it V2 can only be "unknown". */
  sourceAsset?: Address;
  /** Optional pair: with both, V6 checks the request_id derivation (x402 only). */
  purchaseId?: string;
  payer?: Address;
  /** Source search window when only a payment id is given. */
  fromBlock?: bigint;
  toBlock?: bigint;
  lookbackBlocks?: bigint;
  /** How far past the deposit block to look for Released/Refunded (default 50,000 blocks). */
  maxScanBlocks?: bigint;
  /** Destination search window around the deposit time, in seconds. */
  destLookbehindSeconds?: bigint;
  destLookaheadSeconds?: bigint;
}

export interface VerifyDeps {
  readers?: { source?: ChainReader; dest?: ChainReader };
  env?: Readonly<Record<string, string | undefined>>;
  transportFor?: ReaderOptions["transportFor"];
}

export interface NetworkSummary {
  caip2: string;
  name: string;
  environment: string;
  experimental: boolean;
  escrow: string;
  fulfillmentProxy: string;
  rpcOverridden: boolean;
}

export interface VerificationReport {
  tool: typeof TOOL_NAME;
  toolVersion: string;
  disclaimer: string;
  /** True when any involved network is marked experimental (all mainnets). */
  experimental: boolean;
  notices: string[];
  input: Record<string, string>;
  networks: { source: NetworkSummary | null; dest: NetworkSummary | null };
  /** Values read from chain, as strings. Empty when nothing could be read. */
  facts: Record<string, string>;
  checks: CheckResult[];
  summary: VerificationSummary;
  verdict: OverallVerdict;
}

// ---------------------------------------------------------------------------------------------

const T = {
  Deposited: topic0("Deposited"),
  DepositedMany: topic0("DepositedMany"),
  Released: topic0("Released"),
  ReleasedMany: topic0("ReleasedMany"),
  Refunded: topic0("Refunded"),
  RefundedMany: topic0("RefundedMany"),
  Fulfilled: topic0("Fulfilled"),
  FulfilledMany: topic0("FulfilledMany"),
};

/** Every check starts "unknown / not evaluated": a check that is never reached can never pass. */
class CheckBook {
  private readonly map = new Map<string, CheckResult>();
  constructor() {
    for (const c of CHECKS) {
      this.map.set(c.id, { id: c.id, description: c.description, status: "unknown", support: c.support, detail: "not evaluated" });
    }
  }
  set(id: string, status: CheckStatus, detail: string, evidence?: Record<string, string>): void {
    const cur = this.map.get(id);
    if (!cur) throw new Error(`unknown check id ${id}`);
    this.map.set(id, { ...cur, status, detail, ...(evidence ? { evidence } : {}) });
  }
  setAll(status: CheckStatus, detail: string): void {
    for (const id of this.map.keys()) this.set(id, status, detail);
  }
  status(id: string): CheckStatus {
    return this.map.get(id)?.status ?? "unknown";
  }
  list(): CheckResult[] {
    return CHECKS.map((c) => this.map.get(c.id) as CheckResult);
  }
}

interface DLog { log: RawLog; d: Decoded }
type Of<K extends Decoded["kind"]> = { log: RawLog; d: Extract<Decoded, { kind: K }> };
const pick = <K extends Decoded["kind"]>(items: DLog[], kind: K, address: Address): Of<K>[] =>
  items.filter((x) => x.d.kind === kind && addrEq(x.log.address, address)) as unknown as Of<K>[];
const decodeAll = (r: RawReceipt): DLog[] => r.logs.map((log) => ({ log, d: decodeLog(log) }));
const bn = (h: Hex): bigint => BigInt(h);

function logIssue(l: RawLog, address: Address, topic0s: Hex[], from: bigint, to: bigint): string | undefined {
  if (!addrEq(l.address, address)) return `RPC returned a log from ${l.address}, expected ${address}`;
  const t = l.topics[0];
  if (!t || !topic0s.some((x) => hexEq(x, t))) return `RPC returned a log with unexpected topic0 ${t ?? "(none)"}`;
  const b = bn(l.blockNumber);
  if (b < from || b > to) return `RPC returned a log from block ${b}, outside the queried range ${from}..${to}`;
  return undefined;
}

const HASH32 = /^0x[0-9a-fA-F]{64}$/;

function normalize(i: VerifyInput) {
  const need = (cond: boolean, msg: string) => {
    if (!cond) throw new InputError(msg);
  };
  need(Boolean(i.paymentId) || Boolean(i.sourceTx), "one of paymentId / sourceTx is required");
  for (const [k, v] of [["paymentId", i.paymentId], ["sourceTx", i.sourceTx], ["destTx", i.destTx]] as const) {
    if (v !== undefined) need(HASH32.test(v), `${k} must be a 0x-prefixed 32-byte hash`);
  }
  for (const [k, v] of [["destAddress", i.destAddress], ["destAsset", i.destAsset], ["sourceAsset", i.sourceAsset], ["payer", i.payer]] as const) {
    if (v !== undefined) need(isAddress(v, { strict: false }), `${k} must be a 0x address`);
  }
  need(i.amount > 0n, "amount must be a positive integer (atomic units)");
  const markupBps = i.markupBps ?? 300n;
  need(markupBps >= 0n && markupBps <= 1_000_000n, "markupBps must be between 0 and 1,000,000");
  return {
    ...i,
    sourceNetwork: i.sourceNetwork.trim().toLowerCase(),
    destNetwork: i.destNetwork.trim().toLowerCase(),
    markupBps,
    lookbackBlocks: i.lookbackBlocks ?? 100_000n,
    maxScanBlocks: i.maxScanBlocks ?? 50_000n,
    destLookbehindSeconds: i.destLookbehindSeconds ?? 300n,
    destLookaheadSeconds: i.destLookaheadSeconds ?? 3600n,
  };
}
type Norm = ReturnType<typeof normalize>;

const summaryOf = (n: ResolvedNetwork): NetworkSummary => ({
  caip2: n.caip2,
  name: n.name,
  environment: n.environment,
  experimental: n.experimental,
  escrow: n.escrow,
  fulfillmentProxy: n.fulfillmentProxy,
  rpcOverridden: n.rpcOverridden,
});

// ---------------------------------------------------------------------------------------------

interface Facts {
  depositTx?: Hex;
  depositBlock?: bigint;
  depositTs?: bigint;
  deposited?: Of<"Deposited">["d"]["args"];
  commitments?: Of<"DepositCommitments">["d"]["args"];
  releasedOk?: boolean;
  released?: Of<"Released">["d"]["args"];
  releaseTx?: Hex;
  releaseTs?: bigint;
  fulfilled?: Of<"Fulfilled">["d"]["args"];
  fulfillTx?: Hex;
  fulfillBlock?: bigint;
  fulfillTs?: bigint;
  /** Batch events seen anywhere; any entry makes V14 "unsupported". */
  batchNotes: string[];
  /** Scans that failed; any entry keeps V14 from passing. */
  scanFailures: string[];
}

export async function verifyPayment(rawInput: VerifyInput, deps: VerifyDeps = {}): Promise<VerificationReport> {
  const input = normalize(rawInput);
  const book = new CheckBook();
  const env = deps.env ?? process.env;
  const facts: Facts = { batchNotes: [], scanFailures: [] };
  const notices: string[] = [];

  const srcNet = resolveNetwork(input.sourceNetwork, env);
  const dstNet = resolveNetwork(input.destNetwork, env);

  const finish = (): VerificationReport => {
    const checks = book.list();
    const summary = summarize(checks);
    const exp = Boolean(srcNet?.experimental || dstNet?.experimental);
    if (exp) notices.push("EXPERIMENTAL: a mainnet network is involved. No mainnet settlement has been analysed.");
    return {
      tool: TOOL_NAME,
      toolVersion: TOOL_VERSION,
      disclaimer: DISCLAIMER,
      experimental: exp,
      notices,
      input: describeInput(input),
      networks: { source: srcNet ? summaryOf(srcNet) : null, dest: dstNet ? summaryOf(dstNet) : null },
      facts: describeFacts(facts),
      checks,
      summary,
      verdict: overallVerdict(summary),
    };
  };

  if (!srcNet || !dstNet) {
    const which = [!srcNet ? input.sourceNetwork : "", !dstNet ? input.destNetwork : ""].filter(Boolean).join(", ");
    book.setAll("unsupported", `network not configured: ${which}`);
    return finish();
  }
  if (srcNet.rpcs.length === 0 || dstNet.rpcs.length === 0) {
    book.setAll("unsupported", "no RPC configured for a network (set ATUM_VERIFY_RPC_<chainId>)");
    return finish();
  }

  const ropts: ReaderOptions = deps.transportFor ? { transportFor: deps.transportFor } : {};
  const src = deps.readers?.source ?? createReader(srcNet, ropts);
  const dst = deps.readers?.dest ?? createReader(dstNet, ropts);

  const deposit = await locateDeposit(input, srcNet, src, book, facts);
  if (deposit) {
    checkDepositFields(input, srcNet, book, facts, deposit.decoded);
    await scanSourceFollowUps(input, srcNet, src, book, facts);
    await locateFulfillment(input, dstNet, dst, book, facts);
    checkTiming(book, facts);
  } else {
    // Without a located deposit nothing downstream can be evaluated; they stay "unknown".
    for (const c of CHECKS) if (book.status(c.id) === "unknown" && c.id !== "V1") book.set(c.id, "unknown", "not evaluated: the source deposit could not be located (see V1)");
  }
  finishBatchCheck(book, facts);
  return finish();
}

// ---------------------------------------------------------------------------------------------
// Step 1: find the Deposited event (and the receipt that holds the related events)

async function locateDeposit(
  input: Norm,
  net: ResolvedNetwork,
  src: ChainReader,
  book: CheckBook,
  facts: Facts,
): Promise<{ receipt: RawReceipt; decoded: DLog[] } | undefined> {
  let txHash: Hex;
  if (input.sourceTx) {
    txHash = input.sourceTx;
  } else {
    const id = input.paymentId as Hex;
    const head = await src.getBlockNumber();
    if (!head.ok) return void book.set("V1", "unknown", `cannot read source chain head: ${head.reason}`);
    const to = input.toBlock ?? head.value;
    const from = input.fromBlock ?? (head.value > input.lookbackBlocks ? head.value - input.lookbackBlocks : 0n);
    const logs = await src.getLogs({ address: net.escrow, topics: [T.Deposited, id], fromBlock: from, toBlock: to });
    if (!logs.ok) return void book.set("V1", "unknown", `cannot search for the Deposited event: ${logs.reason}`);
    for (const l of logs.value) {
      const issue = logIssue(l, net.escrow, [T.Deposited], from, to);
      if (issue) return void book.set("V1", "fail", issue);
      if (!l.topics[1] || !hexEq(l.topics[1], id)) return void book.set("V1", "fail", "RPC returned a Deposited log for a different depositId");
    }
    if (logs.value.length === 0) {
      return void book.set("V1", "unknown", `no Deposited for this depositId from the configured escrow in blocks ${from}..${to}; widen the window or pass --source-tx`);
    }
    if (logs.value.length > 1) return void book.set("V1", "fail", `${logs.value.length} Deposited events share this depositId`);
    txHash = (logs.value[0] as RawLog).transactionHash;
  }

  const rec = await src.getReceipt(txHash);
  if (!rec.ok) return void book.set("V1", "unknown", `cannot read the source receipt: ${rec.reason}`);
  if (rec.value === null) return void book.set("V1", "unknown", "source transaction not found by the RPC (wrong network, pruned history, or not mined)");
  const receipt = rec.value;
  if (!hexEq(receipt.status, "0x1")) return void book.set("V1", "fail", `source transaction ${txHash} did not succeed (status ${receipt.status})`);

  const decoded = decodeAll(receipt);
  const escrowLogs = decoded.filter((x) => addrEq(x.log.address, net.escrow));
  for (const b of escrowLogs.filter((x) => isBatchKind(x.d.kind))) facts.batchNotes.push(`${b.d.kind} in the deposit transaction`);

  const bad = escrowLogs.filter((x) => x.d.kind === "undecodable" && (x.d as { name: string }).name === "Deposited");
  if (bad.length > 0) return void book.set("V1", "unknown", "a Deposited log from the escrow could not be decoded");

  const foreign = decoded.filter((x) => !addrEq(x.log.address, net.escrow) && x.log.topics[0] !== undefined && hexEq(x.log.topics[0], T.Deposited));
  let deposits = pick(decoded, "Deposited", net.escrow);
  if (input.paymentId) deposits = deposits.filter((x) => hexEq(x.d.args.depositId, input.paymentId as Hex));

  if (deposits.length === 0) {
    if (escrowLogs.some((x) => x.d.kind === "DepositedMany")) {
      return void book.set("V1", "unsupported", "the deposit went through a batch (depositMany) call; batch events are not verified");
    }
    const why = foreign.length > 0 ? ` (${foreign.length} Deposited-shaped log(s) came from other contracts and were ignored)` : "";
    return void book.set("V1", "fail", `no matching Deposited event from the configured escrow ${net.escrow} in ${txHash}${why}`);
  }
  if (deposits.length > 1) return void book.set("V1", "unknown", "several Deposited events in this transaction; pass --payment-id to select one");

  const one = deposits[0] as Of<"Deposited">;
  facts.deposited = one.d.args;
  facts.depositTx = txHash;
  facts.depositBlock = bn(one.log.blockNumber);
  book.set("V1", "pass", `Deposited from ${net.escrow} in successful tx ${txHash}`, {
    depositId: one.d.args.depositId,
    quoteHash: one.d.args.quoteHash,
  });
  return { receipt, decoded };
}

// ---------------------------------------------------------------------------------------------
// Step 2: checks that only need the deposit transaction

function checkDepositFields(input: Norm, net: ResolvedNetwork, book: CheckBook, facts: Facts, decoded: DLog[]): void {
  const D = facts.deposited as NonNullable<Facts["deposited"]>;

  // V2: the token really moved from the depositor into the escrow, and (if asked) it is the expected token.
  const transfers = decoded.filter((x) => x.d.kind === "Transfer" && addrEq(x.log.address, D.token)) as unknown as Of<"Transfer">[];
  const moved = transfers.filter((t) => addrEq(t.d.args.from, D.depositor) && addrEq(t.d.args.to, net.escrow) && t.d.args.value === D.amount);
  if (moved.length !== 1) {
    book.set("V2", "fail", `expected exactly one Transfer(${D.depositor} -> escrow, ${D.amount}) on ${D.token} in the deposit tx, found ${moved.length}`);
  } else if (input.sourceAsset === undefined) {
    book.set("V2", "unknown", "Transfer into escrow matches Deposited.amount, but no expected source asset was given (--source-asset)");
  } else if (!addrEq(D.token, input.sourceAsset)) {
    book.set("V2", "fail", `Deposited.token ${D.token} is not the expected source asset ${input.sourceAsset}`);
  } else {
    book.set("V2", "pass", `Transfer(${D.depositor} -> escrow, ${D.amount}) on ${D.token}`);
  }

  // V3: a spend CAP, not an exact price.
  const cap = (input.amount * (10_000n + input.markupBps)) / 10_000n;
  if (D.amount > 0n && D.amount <= cap) {
    book.set("V3", "pass", `Deposited.amount ${D.amount} <= cap ${cap} (fee ${D.feeAmount} is part of the amount)`, {
      amount: String(D.amount), feeAmount: String(D.feeAmount), cap: String(cap),
    });
  } else {
    book.set("V3", "fail", `Deposited.amount ${D.amount} is not within (0, ${cap}]`, { amount: String(D.amount), cap: String(cap) });
  }

  // V4
  if (addrEq(D.reserver, net.quoteSelector) && addrEq(D.releaser, net.fulfillmentVerifier)) {
    book.set("V4", "pass", "reserver / releaser equal the configured quote_selector / fulfillment_verifier");
  } else {
    book.set("V4", "fail", `reserver ${D.reserver} / releaser ${D.releaser} differ from configured ${net.quoteSelector} / ${net.fulfillmentVerifier}`);
  }

  // V5, V6 need the DepositCommitments event from the same transaction.
  const commits = pick(decoded, "DepositCommitments", net.escrow).filter((c) => hexEq(c.d.args.depositId, D.depositId));
  const undecodableCommit = decoded.some((x) => x.d.kind === "undecodable" && (x.d as { name: string }).name === "DepositCommitments" && addrEq(x.log.address, net.escrow));
  if (commits.length === 1) {
    facts.commitments = (commits[0] as Of<"DepositCommitments">).d.args;
  } else {
    const why = undecodableCommit ? "a DepositCommitments log could not be decoded" : `found ${commits.length} DepositCommitments for this depositId in the deposit tx`;
    book.set("V5", commits.length > 1 ? "fail" : "unknown", why);
    book.set("V6", commits.length > 1 ? "fail" : "unknown", why);
  }
  const C = facts.commitments;
  if (C) {
    if (!input.destNetwork.startsWith("eip155:")) {
      book.set("V5", "unsupported", `destination network ${input.destNetwork} is not an EVM (eip155) network; only EVM destinations were observed`);
    } else {
      const want = destinationHashOf(input.destNetwork, input.destAsset, input.destAddress);
      book.set(
        "V5",
        hexEq(want, C.destinationHash) ? "pass" : "fail",
        hexEq(want, C.destinationHash)
          ? `destinationHash matches keccak256("${destinationString(input.destNetwork, input.destAsset, input.destAddress)}")`
          : `destinationHash ${C.destinationHash} does not match the expected destination (${destinationString(input.destNetwork, input.destAsset, input.destAddress)} -> ${want})`,
        { onChain: C.destinationHash, expected: want },
      );
    }
    if (input.purchaseId !== undefined && input.payer !== undefined) {
      const requestId = deriveX402RequestId(input.purchaseId, input.payer);
      const want = depositRequestHashOf(requestId);
      book.set(
        "V6",
        hexEq(want, C.depositRequestHash) ? "pass" : "fail",
        hexEq(want, C.depositRequestHash)
          ? `depositRequestHash equals keccak256(${requestId}) (x402 derivation)`
          : `depositRequestHash ${C.depositRequestHash} != keccak256(${requestId}) = ${want} (x402 derivation)`,
        { requestId, onChain: C.depositRequestHash, expected: want },
      );
    } else {
      book.set("V6", "unknown", "not requested: pass --purchase-id and --payer to check the x402 request_id derivation");
    }
  }

  // V6b
  if (input.paymentId) {
    book.set(
      "V6b",
      hexEq(input.paymentId, D.depositId) ? "pass" : "fail",
      hexEq(input.paymentId, D.depositId) ? "payment id equals Deposited.depositId" : `payment id ${input.paymentId} != Deposited.depositId ${D.depositId}`,
    );
  } else {
    book.set("V6b", "unknown", "not requested: no --payment-id was given (the deposit was located by --source-tx)");
  }
}

// ---------------------------------------------------------------------------------------------
// Step 3: Released / Refunded / batch events on the source chain

async function scanSourceFollowUps(input: Norm, net: ResolvedNetwork, src: ChainReader, book: CheckBook, facts: Facts): Promise<void> {
  const D = facts.deposited as NonNullable<Facts["deposited"]>;
  const depBlock = facts.depositBlock as bigint;

  const ts = await src.getBlockTimestamp(depBlock);
  if (ts.ok) facts.depositTs = ts.value;

  const head = await src.getBlockNumber();
  if (!head.ok) {
    const why = `cannot read source chain head: ${head.reason}`;
    book.set("V11", "unknown", why);
    book.set("V12", "unknown", why);
    facts.scanFailures.push(why);
    return;
  }
  const lastWanted = depBlock + input.maxScanBlocks - 1n;
  const to = head.value < lastWanted ? head.value : lastWanted;
  const truncated = head.value > to;
  const range = `blocks ${depBlock}..${to}`;

  const [relRes, refRes, batchRes] = await Promise.all([
    src.getLogs({ address: net.escrow, topics: [T.Released, D.depositId], fromBlock: depBlock, toBlock: to }),
    src.getLogs({ address: net.escrow, topics: [T.Refunded, D.depositId], fromBlock: depBlock, toBlock: to }),
    src.getLogs({ address: net.escrow, topics: [[T.DepositedMany, T.ReleasedMany, T.RefundedMany]], fromBlock: depBlock, toBlock: to }),
  ]);

  // Batch events first: they can hide a release/refund from the indexed-topic queries above.
  let batchTouchesDeposit = false;
  let batchUnreadable = false;
  if (!batchRes.ok) {
    facts.scanFailures.push(`batch-event scan failed: ${batchRes.reason}`);
    batchUnreadable = true;
  } else {
    for (const l of batchRes.value) {
      const issue = logIssue(l, net.escrow, [T.DepositedMany, T.ReleasedMany, T.RefundedMany], depBlock, to);
      if (issue) {
        facts.scanFailures.push(issue);
        batchUnreadable = true;
        continue;
      }
      const d = decodeLog(l);
      if (d.kind !== "DepositedMany" && d.kind !== "ReleasedMany" && d.kind !== "RefundedMany") {
        batchUnreadable = true;
        facts.scanFailures.push(`a batch-event log in tx ${l.transactionHash} could not be decoded`);
        continue;
      }
      facts.batchNotes.push(`${d.kind} in tx ${l.transactionHash}`);
      if (d.ids.some((id) => hexEq(id, D.depositId))) batchTouchesDeposit = true;
    }
  }

  // ---- V12: Refunded
  if (!refRes.ok) {
    book.set("V12", "unknown", `cannot scan for Refunded: ${refRes.reason}`);
    facts.scanFailures.push(`Refunded scan failed: ${refRes.reason}`);
  } else {
    const issue = refRes.value.map((l) => logIssue(l, net.escrow, [T.Refunded], depBlock, to)).find(Boolean);
    if (issue) book.set("V12", "fail", issue);
    else if (refRes.value.length > 0) book.set("V12", "fail", `${refRes.value.length} Refunded event(s) exist for this depositId (first in tx ${(refRes.value[0] as RawLog).transactionHash})`);
    else if (batchTouchesDeposit) book.set("V12", "unsupported", "this depositId appears in a batch event; batch refunds are not verified");
    else if (batchUnreadable) book.set("V12", "unknown", "batch events could not be fully read, so a batched refund cannot be ruled out");
    else if (!(relRes.ok && relRes.value.length === 1)) book.set("V12", "unknown", `no Refunded in ${range}, but no Released was found either, so an empty answer is not corroborated`);
    else if (truncated) book.set("V12", "unknown", `no Refunded in ${range}, but the deposit is older than the scanned window (head ${head.value})`);
    else book.set("V12", "pass", `no Refunded for this depositId in ${range} (scan reached the chain head)`);
  }

  // ---- V11: Released
  if (!relRes.ok) {
    book.set("V11", "unknown", `cannot scan for Released: ${relRes.reason}`);
    facts.scanFailures.push(`Released scan failed: ${relRes.reason}`);
    return;
  }
  const relIssue = relRes.value.map((l) => logIssue(l, net.escrow, [T.Released], depBlock, to)).find(Boolean);
  if (relIssue) return void book.set("V11", "fail", relIssue);
  if (relRes.value.length > 1) return void book.set("V11", "fail", `${relRes.value.length} Released events exist for this depositId`);
  if (relRes.value.length === 0) {
    if (batchTouchesDeposit) return void book.set("V11", "unsupported", "this depositId appears in a batch event; batch releases are not verified");
    if (batchUnreadable) return void book.set("V11", "unknown", "no single Released found, and batch events could not be fully read");
    return void book.set("V11", "unknown", `no Released for this depositId in ${range}; the payment may still be pending`);
  }
  const relLog = relRes.value[0] as RawLog;
  const rd = decodeLog(relLog);
  if (rd.kind !== "Released") return void book.set("V11", "unknown", "the Released log could not be decoded");
  const R = rd.args;
  if (!hexEq(R.depositId, D.depositId)) return void book.set("V11", "fail", "Released.depositId differs from the deposit");
  if (!addrEq(R.settler, D.settler) || !addrEq(R.token, D.token) || R.amount !== D.amount || R.feeAmount !== D.feeAmount) {
    return void book.set("V11", "fail", `Released (settler ${R.settler}, token ${R.token}, amount ${R.amount}, fee ${R.feeAmount}) differs from Deposited (settler ${D.settler}, token ${D.token}, amount ${D.amount}, fee ${D.feeAmount})`);
  }
  facts.released = R;
  facts.releaseTx = relLog.transactionHash;
  const rec = await src.getReceipt(relLog.transactionHash);
  if (!rec.ok || rec.value === null) return void book.set("V11", "unknown", `cannot read the release receipt: ${rec.ok ? "not found" : rec.reason}`);
  if (!hexEq(rec.value.status, "0x1")) return void book.set("V11", "fail", "the release transaction did not succeed");
  const payout = D.amount - D.feeAmount;
  const xfers = decodeAll(rec.value).filter((x) => x.d.kind === "Transfer" && addrEq(x.log.address, D.token)) as unknown as Of<"Transfer">[];
  const paid = xfers.filter((t) => addrEq(t.d.args.from, net.escrow) && addrEq(t.d.args.to, D.settler) && t.d.args.value === payout);
  if (paid.length !== 1) {
    return void book.set("V11", "fail", `expected exactly one Transfer(escrow -> settler, ${payout}) on ${D.token} in the release tx, found ${paid.length}`);
  }
  facts.releasedOk = true;
  const rts = await src.getBlockTimestamp(bn(relLog.blockNumber));
  if (rts.ok) facts.releaseTs = rts.value;
  book.set("V11", "pass", `Released in ${relLog.transactionHash}; settler received amount - fee = ${payout}`, { payout: String(payout) });
}

// ---------------------------------------------------------------------------------------------
// Step 4: the destination chain

async function locateFulfillment(
  input: Norm,
  dstNet: ResolvedNetwork,
  dst: ChainReader,
  book: CheckBook,
  facts: Facts,
): Promise<void> {
  const D = facts.deposited as NonNullable<Facts["deposited"]>;
  const missingStatus = (): CheckStatus => (facts.releasedOk ? "fail" : "unknown");
  // V7 carries the outcome. V8-V10 need a located Fulfilled event, so without one they are "unknown"
  // (or "unsupported" when V7 is), never "fail" or "pass" on their own.
  const setV7to10 = (status: CheckStatus, detail: string) => {
    book.set("V7", status, detail);
    for (const id of ["V8", "V9", "V10"]) book.set(id, status === "unsupported" ? "unsupported" : "unknown", `not evaluated: ${detail}`);
  };

  let fulfilledLogs: RawLog[];
  let windowText = "";
  let receiptFromTx: RawReceipt | undefined;

  if (input.destTx) {
    const rec = await dst.getReceipt(input.destTx);
    if (!rec.ok) return setV7to10("unknown", `cannot read the destination receipt: ${rec.reason}`);
    if (rec.value === null) return setV7to10("unknown", "destination transaction not found by the RPC");
    receiptFromTx = rec.value;
    const dec = decodeAll(rec.value);
    for (const b of dec) {
      if (!addrEq(b.log.address, dstNet.fulfillmentProxy) || b.d.kind !== "FulfilledMany") continue;
      facts.batchNotes.push(`FulfilledMany in destination tx ${input.destTx}`);
      if (b.d.ids.some((id) => hexEq(id, D.quoteHash))) return setV7to10("unsupported", "the fulfillment went through a batch (fulfillMany) call; batch events are not verified");
    }
    fulfilledLogs = rec.value.logs.filter((l) => l.topics[0] !== undefined && hexEq(l.topics[0], T.Fulfilled) && l.topics[1] !== undefined && hexEq(l.topics[1], D.quoteHash));
    windowText = `destination tx ${input.destTx}`;
  } else {
    if (facts.depositTs === undefined) return setV7to10("unknown", "the deposit block timestamp could not be read, so no destination search window exists");
    const head = await dst.getBlockNumber();
    if (!head.ok) return setV7to10("unknown", `cannot read destination chain head: ${head.reason}`);
    const from = await dst.firstBlockAtOrAfter(facts.depositTs - input.destLookbehindSeconds, head.value);
    if (!from.ok) return setV7to10("unknown", `cannot locate the destination search window: ${from.reason}`);
    const next = await dst.firstBlockAtOrAfter(facts.depositTs + input.destLookaheadSeconds + 1n, head.value);
    if (!next.ok) return setV7to10("unknown", `cannot locate the destination search window: ${next.reason}`);
    const to = next.value - 1n > head.value ? head.value : next.value - 1n;
    windowText = `destination blocks ${from.value}..${to}`;
    const [logs, many] = await Promise.all([
      dst.getLogs({ address: dstNet.fulfillmentProxy, topics: [T.Fulfilled, D.quoteHash], fromBlock: from.value, toBlock: to }),
      dst.getLogs({ address: dstNet.fulfillmentProxy, topics: [T.FulfilledMany], fromBlock: from.value, toBlock: to }),
    ]);
    if (!logs.ok) return setV7to10("unknown", `cannot search for Fulfilled: ${logs.reason}`);
    for (const l of logs.value) {
      const issue = logIssue(l, dstNet.fulfillmentProxy, [T.Fulfilled], from.value, to);
      if (issue) return setV7to10("fail", issue);
      if (!l.topics[1] || !hexEq(l.topics[1], D.quoteHash)) return setV7to10("fail", "RPC returned a Fulfilled log for a different quoteHash");
    }
    if (!many.ok) {
      facts.scanFailures.push(`FulfilledMany scan failed: ${many.reason}`);
    } else {
      for (const l of many.value) {
        const issue = logIssue(l, dstNet.fulfillmentProxy, [T.FulfilledMany], from.value, to);
        const d = issue ? undefined : decodeLog(l);
        if (!d || d.kind !== "FulfilledMany") {
          facts.scanFailures.push(issue ?? `a FulfilledMany log in tx ${l.transactionHash} could not be decoded`);
          continue;
        }
        facts.batchNotes.push(`FulfilledMany in destination tx ${l.transactionHash}`);
        if (d.ids.some((id) => hexEq(id, D.quoteHash))) return setV7to10("unsupported", "this quoteHash appears in a batch FulfilledMany event; batch fulfillments are not verified");
      }
    }
    fulfilledLogs = logs.value;
  }

  if (fulfilledLogs.length === 0) {
    return setV7to10(missingStatus(), `no Fulfilled for quoteHash ${D.quoteHash} from ${dstNet.fulfillmentProxy} in ${windowText}${facts.releasedOk ? " although the source escrow released the funds" : " (the payment may be pending, or the window too short)"}`);
  }
  if (fulfilledLogs.length > 1) return setV7to10("fail", `${fulfilledLogs.length} Fulfilled events carry this quoteHash`);

  const fLog = fulfilledLogs[0] as RawLog;
  if (!addrEq(fLog.address, dstNet.fulfillmentProxy)) {
    return setV7to10("fail", `Fulfilled was emitted by ${fLog.address}, not the configured proxy ${dstNet.fulfillmentProxy}`);
  }
  const fd = decodeLog(fLog);
  if (fd.kind !== "Fulfilled") return setV7to10("unknown", "the Fulfilled log could not be decoded");
  const F = fd.args;
  if (!hexEq(F.quoteHash, D.quoteHash)) {
    return setV7to10("fail", `Fulfilled.quoteHash ${F.quoteHash} != Deposited.quoteHash ${D.quoteHash}`);
  }

  const rec = receiptFromTx ?? (await (async () => {
    const r = await dst.getReceipt(fLog.transactionHash);
    return r.ok ? r.value : undefined;
  })());
  if (!rec) {
    book.set("V7", "unknown", "Fulfilled found, but its transaction receipt could not be read");
    for (const id of ["V8", "V9", "V10"]) book.set(id, "unknown", "the destination receipt could not be read");
    return;
  }
  if (!hexEq(rec.status, "0x1")) {
    return setV7to10("fail", `the destination transaction ${fLog.transactionHash} did not succeed`);
  }
  facts.fulfilled = F;
  facts.fulfillTx = fLog.transactionHash;
  facts.fulfillBlock = bn(fLog.blockNumber);
  book.set("V7", "pass", `Fulfilled from ${dstNet.fulfillmentProxy} carries the same quoteHash (${windowText})`, { quoteHash: F.quoteHash });

  // V8
  const problems: string[] = [];
  if (!addrEq(F.to, input.destAddress)) problems.push(`to ${F.to} != ${input.destAddress}`);
  if (!addrEq(F.token, input.destAsset)) problems.push(`token ${F.token} != ${input.destAsset}`);
  if (F.amount !== input.amount) problems.push(`amount ${F.amount} != ${input.amount}`);
  book.set("V8", problems.length === 0 ? "pass" : "fail", problems.length === 0 ? `Fulfilled to ${F.to}, token ${F.token}, amount ${F.amount} as expected` : `Fulfilled differs from expectation: ${problems.join("; ")}`);

  // V9
  const xfers = decodeAll(rec).filter((x) => x.d.kind === "Transfer" && addrEq(x.log.address, F.token)) as unknown as Of<"Transfer">[];
  const got = xfers.filter((t) => addrEq(t.d.args.to, F.to) && t.d.args.value === F.amount);
  book.set("V9", got.length === 1 ? "pass" : "fail", got.length === 1 ? `ERC20 Transfer of ${F.amount} to ${F.to} on ${F.token} in the destination tx` : `expected exactly one Transfer(-> ${F.to}, ${F.amount}) on ${F.token} in the destination tx, found ${got.length}`);

  // V10
  const settlers = [D.settler, F.settler, ...(facts.released ? [facts.released.settler] : [])];
  const same = settlers.every((s) => addrEq(s, D.settler));
  book.set("V10", same ? "pass" : "fail", same ? `settler ${D.settler} is the same on deposit, fulfillment${facts.released ? " and release" : ""}` : `settlers differ: deposit ${D.settler}, fulfillment ${F.settler}${facts.released ? `, release ${facts.released.settler}` : ""}`);

  const bts = await dst.getBlockTimestamp(facts.fulfillBlock);
  if (bts.ok) facts.fulfillTs = bts.value;
}

// ---------------------------------------------------------------------------------------------

function checkTiming(book: CheckBook, facts: Facts): void {
  const { depositTs, fulfillTs, releaseTs, fulfilled } = facts;
  if (depositTs === undefined || fulfillTs === undefined || releaseTs === undefined || fulfilled === undefined) {
    book.set("V13", "unknown", "a timestamp is missing (deposit, fulfillment or release not all found)");
    return;
  }
  if (fulfilled.timestamp !== fulfillTs) {
    book.set("V13", "fail", `Fulfilled.timestamp ${fulfilled.timestamp} != destination block timestamp ${fulfillTs}`);
    return;
  }
  const ok = depositTs <= fulfillTs && fulfillTs <= releaseTs;
  book.set("V13", ok ? "pass" : "fail", `deposit ${depositTs}, fulfilled ${fulfillTs}, released ${releaseTs} (unix seconds; chains' clocks are compared as reported)`, {
    deposit: String(depositTs), fulfilled: String(fulfillTs), released: String(releaseTs),
  });
}

function finishBatchCheck(book: CheckBook, facts: Facts): void {
  if (facts.batchNotes.length > 0) {
    book.set("V14", "unsupported", `batch events were found and are not verified: ${[...new Set(facts.batchNotes)].join("; ")}`);
  } else if (facts.scanFailures.length > 0) {
    book.set("V14", "unknown", `batch events could not be ruled out: ${facts.scanFailures.join("; ")}`);
  } else if (facts.deposited === undefined) {
    book.set("V14", "unknown", "not evaluated: the source deposit could not be located");
  } else if (book.status("V7") === "unknown" || book.status("V11") === "unknown") {
    book.set("V14", "unknown", "batch scans were incomplete because the destination or release step could not be evaluated");
  } else {
    book.set("V14", "pass", "no batch (*Many) events were found in the scanned ranges");
  }
}

// ---------------------------------------------------------------------------------------------

function describeInput(i: Norm): Record<string, string> {
  const out: Record<string, string> = {
    sourceNetwork: i.sourceNetwork,
    destNetwork: i.destNetwork,
    destAddress: i.destAddress,
    destAsset: i.destAsset,
    amount: String(i.amount),
    markupBps: String(i.markupBps),
  };
  for (const [k, v] of Object.entries({ paymentId: i.paymentId, sourceTx: i.sourceTx, destTx: i.destTx, sourceAsset: i.sourceAsset, purchaseId: i.purchaseId, payer: i.payer })) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function describeFacts(f: Facts): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (k: string, v: unknown) => {
    if (v !== undefined) out[k] = String(v);
  };
  put("depositTx", f.depositTx);
  put("depositBlock", f.depositBlock);
  put("depositTimestamp", f.depositTs);
  put("depositId", f.deposited?.depositId);
  put("quoteHash", f.deposited?.quoteHash);
  put("depositor", f.deposited?.depositor);
  put("settler", f.deposited?.settler);
  put("sourceToken", f.deposited?.token);
  put("sourceAmount", f.deposited?.amount);
  put("feeAmount", f.deposited?.feeAmount);
  put("depositRequestHash", f.commitments?.depositRequestHash);
  put("destinationHash", f.commitments?.destinationHash);
  put("releaseTx", f.releaseTx);
  put("releaseTimestamp", f.releaseTs);
  put("fulfillmentTx", f.fulfillTx);
  put("fulfillmentBlock", f.fulfillBlock);
  put("fulfillmentTimestamp", f.fulfillTs);
  put("fulfilledTo", f.fulfilled?.to);
  put("fulfilledToken", f.fulfilled?.token);
  put("fulfilledAmount", f.fulfilled?.amount);
  return out;
}
