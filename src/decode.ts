import { decodeEventLog, toEventSelector, type Address, type Hex } from "viem";
import { erc20Events, escrowEvents, proxyEvents } from "./abi.js";
import type { RawLog } from "./rpc.js";

export interface DepositedArgs {
  depositId: Hex;
  quoteHash: Hex;
  depositor: Address;
  settler: Address;
  token: Address;
  amount: bigint;
  feeAmount: bigint;
  reserver: Address;
  releaser: Address;
}
export interface CommitmentsArgs { depositId: Hex; depositRequestHash: Hex; destinationHash: Hex }
export interface ReleasedArgs { depositId: Hex; settler: Address; token: Address; amount: bigint; feeAmount: bigint }
export interface RefundedArgs { depositId: Hex; depositor: Address; token: Address; amount: bigint }
export interface FulfilledArgs { quoteHash: Hex; settler: Address; to: Address; token: Address; amount: bigint; timestamp: bigint }
export interface TransferArgs { from: Address; to: Address; value: bigint }

export type BatchKind = "DepositedMany" | "ReleasedMany" | "RefundedMany" | "FulfilledMany";

export type Decoded =
  | { kind: "Deposited"; args: DepositedArgs }
  | { kind: "DepositCommitments"; args: CommitmentsArgs }
  | { kind: "Released"; args: ReleasedArgs }
  | { kind: "Refunded"; args: RefundedArgs }
  | { kind: "Fulfilled"; args: FulfilledArgs }
  | { kind: "Transfer"; args: TransferArgs }
  /** A batch event. `ids` are the depositIds (or quoteHashes for FulfilledMany) it contains. */
  | { kind: BatchKind; ids: Hex[] }
  /** topic0 is known but the data/topics did not decode: never treated as "absent". */
  | { kind: "undecodable"; name: string; reason: string }
  /** topic0 is not one the verifier knows. */
  | { kind: "unknown" };

type AbiEvent = Extract<(typeof escrowEvents | typeof proxyEvents | typeof erc20Events)[number], { type: "event" }>;
const allEvents = [...escrowEvents, ...proxyEvents, ...erc20Events] as readonly AbiEvent[];
const bySelector = new Map<string, AbiEvent>();
for (const ev of allEvents) bySelector.set(toEventSelector(ev).toLowerCase(), ev);

/** topic0 for a known event name (throws on a typo; used at module load by callers). */
export function topic0(name: string): Hex {
  const ev = allEvents.find((e) => e.name === name);
  if (!ev) throw new Error(`unknown event ${name}`);
  return toEventSelector(ev);
}

export function isBatchKind(kind: string): kind is BatchKind {
  return kind === "DepositedMany" || kind === "ReleasedMany" || kind === "RefundedMany" || kind === "FulfilledMany";
}

export function decodeLog(log: RawLog): Decoded {
  const t0 = log.topics[0];
  if (!t0) return { kind: "unknown" };
  const ev = bySelector.get(t0.toLowerCase());
  if (!ev) return { kind: "unknown" };
  try {
    const d = decodeEventLog({
      abi: [ev],
      data: log.data,
      topics: log.topics as [Hex, ...Hex[]],
      strict: true,
    }) as { eventName: string; args: Record<string, unknown> };
    const a = d.args;
    const name: string = ev.name;
    switch (name) {
      case "Deposited":
      case "DepositCommitments":
      case "Released":
      case "Refunded":
      case "Fulfilled":
        return { kind: name, args: a } as unknown as Decoded;
      case "Transfer":
        return { kind: "Transfer", args: { from: a.from, to: a.to, value: a.value } as TransferArgs };
      case "DepositedMany":
        return { kind: "DepositedMany", ids: [...(a.depositIds as Hex[])] };
      case "ReleasedMany":
        return { kind: "ReleasedMany", ids: (a.releaseWitnesses as { depositId: Hex }[]).map((w) => w.depositId) };
      case "RefundedMany":
        return { kind: "RefundedMany", ids: (a.refundWitnesses as { depositId: Hex }[]).map((w) => w.depositId) };
      case "FulfilledMany":
        return { kind: "FulfilledMany", ids: (a.fulfillments as { quoteHash: Hex }[]).map((f) => f.quoteHash) };
      default:
        return { kind: "unknown" };
    }
  } catch (err) {
    return { kind: "undecodable", name: ev.name, reason: err instanceof Error ? err.message.split("\n")[0] ?? "decode error" : "decode error" };
  }
}

export const addrEq = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
export const hexEq = addrEq;
