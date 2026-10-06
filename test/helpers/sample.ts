import { readFileSync } from "node:fs";
import { encodeAbiParameters, encodeEventTopics, toHex, type Abi, type Address, type Hex } from "viem";
import { escrowEvents, proxyEvents } from "../../src/abi.js";
import { resolveNetwork } from "../../src/config/index.js";
import { createReader, type ChainReader } from "../../src/rpc.js";
import { verifyPayment, type VerificationReport, type VerifyInput } from "../../src/verify.js";
import { FakeChain, type FakeChainOptions } from "./fake-chain.js";

export type Json = Record<string, unknown>;

const load = (name: string): Json => JSON.parse(readFileSync(new URL(`../fixtures/sample-001/${name}`, import.meta.url), "utf8")) as Json;

export interface Sample {
  expected: {
    input: Record<string, string>;
    txs: { deposit: Hex; release: Hex; fulfillment: Hex };
    values: Record<string, string>;
    timeline: Record<string, number>;
  };
  deposit: Json;
  release: Json;
  fulfill: Json;
  extraSourceLogs: Json[];
  extraDestLogs: Json[];
}

/** Fresh deep copy of the fixtures, safe to mutate. */
export function loadSample(): Sample {
  return {
    expected: load("expected.json") as unknown as Sample["expected"],
    deposit: load("base-sepolia.deposit-receipt.json"),
    release: load("base-sepolia.release-receipt.json"),
    fulfill: load("arbitrum-sepolia.fulfill-receipt.json"),
    extraSourceLogs: [],
    extraDestLogs: [],
  };
}

export const logsOf = (receipt: Json): Json[] => receipt.logs as Json[];

export function baseInput(s: Sample): VerifyInput {
  const i = s.expected.input;
  return {
    sourceNetwork: i.sourceNetwork as string,
    destNetwork: i.destNetwork as string,
    paymentId: i.paymentId as Hex,
    destAddress: i.destAddress as Address,
    destAsset: i.destAsset as Address,
    sourceAsset: i.sourceAsset as Address,
    amount: BigInt(i.amount as string),
    markupBps: BigInt(i.markupBps as string),
    purchaseId: i.purchaseId as string,
    payer: i.payer as Address,
  };
}

export interface Rig {
  readers: { source: ChainReader; dest: ChainReader };
  srcChain: FakeChain;
  dstChain: FakeChain;
}

export function makeRig(s: Sample, over: { src?: Partial<FakeChainOptions>; dst?: Partial<FakeChainOptions> } = {}): Rig {
  const t = s.expected.timeline as Record<string, number>;
  const srcChain = new FakeChain({
    receipts: [s.deposit, s.release],
    extraLogs: s.extraSourceLogs,
    head: BigInt(t.sourceHead as number),
    anchorBlock: BigInt(t.depositBlock as number),
    anchorTs: BigInt(t.depositTimestamp as number),
    secondsPerBlock: 2,
    ...over.src,
  });
  const dstChain = new FakeChain({
    receipts: [s.fulfill],
    extraLogs: s.extraDestLogs,
    head: BigInt(t.fulfillmentBlock as number) + 4000n,
    anchorBlock: BigInt(t.fulfillmentBlock as number),
    anchorTs: BigInt(t.fulfillmentTimestamp as number),
    secondsPerBlock: 0.25,
    ...over.dst,
  });
  const srcNet = resolveNetwork("eip155:84532", {});
  const dstNet = resolveNetwork("eip155:421614", {});
  if (!srcNet || !dstNet) throw new Error("test networks missing from config");
  return {
    readers: {
      source: createReader(srcNet, { transportFor: () => srcChain.transport() }),
      dest: createReader(dstNet, { transportFor: () => dstChain.transport() }),
    },
    srcChain,
    dstChain,
  };
}

export async function run(
  s: Sample,
  opts: {
    input?: Partial<VerifyInput>;
    /** Input fields to remove from the base input (an absent field is not the same as `undefined` overrides). */
    omit?: (keyof VerifyInput)[];
    src?: Partial<FakeChainOptions>;
    dst?: Partial<FakeChainOptions>;
  } = {},
): Promise<VerificationReport & { rig: Rig }> {
  const rig = makeRig(s, { ...(opts.src ? { src: opts.src } : {}), ...(opts.dst ? { dst: opts.dst } : {}) });
  const input = { ...baseInput(s), ...opts.input } as VerifyInput;
  for (const k of opts.omit ?? []) delete input[k];
  const report = await verifyPayment(input, { readers: rig.readers, env: {} });
  return Object.assign(report, { rig });
}

export const statusOf = (r: VerificationReport, id: string): string => r.checks.find((c) => c.id === id)?.status ?? "missing";

// ---- mutation helpers --------------------------------------------------------------------------

/** Replace whole 32-byte words in the data of every log of a receipt. */
export function replaceWords(receipt: Json, pairs: [string, string][], onlyLogIndex?: number): void {
  const map = new Map(pairs.map(([a, b]) => [a.toLowerCase(), b.toLowerCase()]));
  logsOf(receipt).forEach((log, idx) => {
    if (onlyLogIndex !== undefined && idx !== onlyLogIndex) return;
    const data = String(log.data).slice(2);
    const words = data.match(/.{64}/g) ?? [];
    log.data = "0x" + words.map((w) => map.get(w.toLowerCase()) ?? w).join("");
  });
}

export const word = (n: bigint): string => n.toString(16).padStart(64, "0");
export const addrWord = (a: string): string => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

/** Flip the last hex digit of a 0x string. */
export const flipLastDigit = (h: string): string => h.slice(0, -1) + (h.endsWith("0") ? "1" : "0");

/** Encode an event log from its ABI, in the raw RPC shape. */
export function eventLog(
  abi: Abi,
  eventName: string,
  args: Record<string, unknown>,
  address: Address,
  blockNumber: bigint,
  txHash: Hex,
  logIndex = 9,
): Json {
  const item = (abi as unknown as readonly { type: string; name?: string; inputs: { name?: string; indexed?: boolean }[] }[]).find(
    (i) => i.type === "event" && i.name === eventName,
  );
  if (!item) throw new Error(`event ${eventName} not in ABI`);
  const topics = encodeEventTopics({ abi: [item], eventName, args } as never);
  const nonIndexed = item.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(nonIndexed as never, nonIndexed.map((i) => args[i.name as string]) as never);
  return {
    address: address.toLowerCase(),
    topics,
    data,
    blockNumber: toHex(blockNumber),
    transactionHash: txHash,
    logIndex: toHex(logIndex),
    removed: false,
  };
}

export const ESCROW: Address = "0x0F875601504C9179562506AFa34b2D084268869b";
export const PROXY: Address = "0x1F1F8FA642bc5F530ba37F1Db3a656E9eB8BaFeb";
export const escrowAbi = escrowEvents as unknown as Abi;
export const proxyAbi = proxyEvents as unknown as Abi;

export const ZERO32 = ("0x" + "00".repeat(32)) as Hex;
export const witness = (depositId: Hex) => ({
  depositId,
  quoteHash: ZERO32,
  depositRequestHash: ZERO32,
  destinationHash: ZERO32,
  depositor: "0x0000000000000000000000000000000000000001" as Address,
  token: "0x0000000000000000000000000000000000000002" as Address,
  amount: 1n,
  feeAmount: 0n,
  reserver: "0x0000000000000000000000000000000000000003" as Address,
  releaser: "0x0000000000000000000000000000000000000004" as Address,
  settler: "0x0000000000000000000000000000000000000005" as Address,
});
