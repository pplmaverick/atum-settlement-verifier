import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import { CHECKS } from "../src/checks.js";
import { InputError, verifyPayment, type VerifyInput } from "../src/verify.js";
import {
  ESCROW, PROXY, ZERO32, addrWord, baseInput, escrowAbi, eventLog, flipLastDigit, loadSample, logsOf, makeRig, proxyAbi,
  replaceWords, run, statusOf, witness, word, type Sample,
} from "./helpers/sample.js";

const SETTLER = "0x0eEE42EC90Eb7D1e53504fb508790e410a286A11" as Address;

const allPass = (r: { checks: { status: string }[] }) => r.checks.every((c) => c.status === "pass");

describe("sample 001 (positive)", () => {
  it("passes every check and matches the recorded sample", async () => {
    const s = loadSample();
    const r = await run(s);
    for (const c of r.checks) expect(c.status, `${c.id}: ${c.detail}`).toBe("pass");
    expect(r.checks).toHaveLength(CHECKS.length);
    expect(r.summary).toEqual({ pass: CHECKS.length, fail: 0, unknown: 0, unsupported: 0 });
    expect(r.verdict).toBe("pass");
    expect(r.experimental).toBe(false);

    const v = s.expected.values;
    expect(r.facts.depositTx).toBe(s.expected.txs.deposit);
    expect(r.facts.releaseTx).toBe(s.expected.txs.release);
    expect(r.facts.fulfillmentTx).toBe(s.expected.txs.fulfillment);
    expect(r.facts.depositId).toBe(v.depositId);
    expect(r.facts.quoteHash).toBe(v.quoteHash);
    expect(r.facts.settler).toBe(v.settler);
    expect(r.facts.sourceAmount).toBe(v.sourceAmount);
    expect(r.facts.feeAmount).toBe(v.feeAmount);
    expect(r.facts.depositRequestHash).toBe(v.depositRequestHash);
    expect(r.facts.destinationHash).toBe(v.destinationHash);
    expect(r.facts.depositTimestamp).toBe(String(s.expected.timeline.depositTimestamp));
    expect(r.facts.releaseTimestamp).toBe(String(s.expected.timeline.releaseTimestamp));
    expect(r.facts.fulfillmentTimestamp).toBe(String(s.expected.timeline.fulfillmentTimestamp));
    expect(r.checks.find((c) => c.id === "V6")?.evidence?.requestId).toBe(v.requestId);
  });

  it("every check carries an evidence level and a reason", async () => {
    const r = await run(loadSample());
    for (const c of r.checks) {
      expect(c.support).toBeTruthy();
      expect(c.detail.length).toBeGreaterThan(0);
    }
  });

  it("works from the source tx and the destination tx instead of searching (V6b is then 'unknown', not 'pass')", async () => {
    const s = loadSample();
    const r = await run(s, { omit: ["paymentId"], input: { sourceTx: s.expected.txs.deposit, destTx: s.expected.txs.fulfillment } });
    for (const c of r.checks) if (c.id !== "V6b") expect(c.status, `${c.id}: ${c.detail}`).toBe("pass");
    expect(statusOf(r, "V6b")).toBe("unknown");
    expect(r.verdict).toBe("inconclusive");
    // The destination receipt was read directly, so no destination log search was made.
    expect(r.rig.dstChain.calls.filter((c) => c.method === "eth_getLogs")).toHaveLength(0);
  });

  it("without optional inputs the optional checks are 'unknown' and the verdict is not 'pass'", async () => {
    const s = loadSample();
    const r = await run(s, { omit: ["sourceAsset", "purchaseId", "payer"] });
    expect(statusOf(r, "V2")).toBe("unknown");
    expect(statusOf(r, "V6")).toBe("unknown");
    expect(r.checks.filter((c) => c.status === "fail")).toHaveLength(0);
    expect(r.verdict).toBe("inconclusive");
  });

  it("V3 is a cap: 50000 <= 51500 passes, and a lower expected amount (cap below the deposit) fails", async () => {
    const s = loadSample();
    expect(statusOf(await run(s), "V3")).toBe("pass");
    const r = await run(loadSample(), { input: { amount: 40_000n } });
    expect(statusOf(r, "V3")).toBe("fail"); // cap = 41,200 < 50,000
  });

  it("marks mainnet networks as experimental", async () => {
    const s = loadSample();
    const r = await verifyPayment(
      { ...baseInput(s), sourceNetwork: "eip155:8453", destNetwork: "eip155:42161" },
      { readers: makeRig(s).readers, env: {} },
    );
    expect(r.experimental).toBe(true);
    expect(r.verdict).not.toBe("pass");
  });
});

interface Case {
  name: string;
  setup: (s: Sample) => { input?: Partial<VerifyInput>; omit?: (keyof VerifyInput)[]; src?: object; dst?: object } | void;
  /** id -> allowed statuses. Anything listed must NOT be "pass". */
  expect: Record<string, string[]>;
  verdict: "fail" | "inconclusive";
}

const OTHER = "0x1111111111111111111111111111111111111111";
const DEPOSIT_BLOCK = 47_751_527n;
const DEST_BLOCK = 316_290_985n;

const cases: Case[] = [
  {
    name: "quoteHash differs by one digit on the source (Deposited)",
    setup: (s) => { (logsOf(s.deposit)[1]!.topics as string[])[2] = flipLastDigit((logsOf(s.deposit)[1]!.topics as string[])[2]!); },
    expect: { V7: ["fail"] }, verdict: "fail",
  },
  {
    name: "quoteHash differs by one digit on the destination (Fulfilled)",
    setup: (s) => { (logsOf(s.fulfill)[1]!.topics as string[])[1] = flipLastDigit((logsOf(s.fulfill)[1]!.topics as string[])[1]!); },
    expect: { V7: ["fail"] }, verdict: "fail",
  },
  {
    name: "RPC ignores the topic filter and returns a Fulfilled with another quoteHash",
    setup: (s) => {
      (logsOf(s.fulfill)[1]!.topics as string[])[1] = flipLastDigit((logsOf(s.fulfill)[1]!.topics as string[])[1]!);
      return { dst: { ignoreTopicFilter: true } };
    },
    expect: { V7: ["fail"] }, verdict: "fail",
  },
  {
    name: "destination amount is 1 less (Fulfilled and Transfer agree)",
    setup: (s) => replaceWords(s.fulfill, [[word(50_000n), word(49_999n)]]),
    expect: { V8: ["fail"] }, verdict: "fail",
  },
  {
    name: "destination amount is 1 less in Fulfilled only (Transfer still 50000)",
    setup: (s) => replaceWords(s.fulfill, [[word(50_000n), word(49_999n)]], 1),
    expect: { V8: ["fail"], V9: ["fail"] }, verdict: "fail",
  },
  {
    name: "Fulfilled.to is a different address",
    setup: (s) => replaceWords(s.fulfill, [[addrWord(s.expected.input.destAddress as string), addrWord(OTHER)]], 1),
    expect: { V8: ["fail"], V9: ["fail"] }, verdict: "fail",
  },
  {
    name: "the expected recipient differs from the one on chain",
    setup: () => ({ input: { destAddress: OTHER as Address } }),
    expect: { V5: ["fail"], V8: ["fail"] }, verdict: "fail",
  },
  {
    name: "the expected destination asset differs from the one on chain",
    setup: () => ({ input: { destAsset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as Address } }),
    expect: { V5: ["fail"], V8: ["fail"] }, verdict: "fail",
  },
  {
    name: "Fulfilled is missing although the escrow released the funds",
    setup: (s) => { logsOf(s.fulfill).splice(1, 1); },
    expect: { V7: ["fail"], V8: ["unknown"], V9: ["unknown"], V10: ["unknown"] }, verdict: "fail",
  },
  {
    name: "Fulfilled and Released are both missing (a pending payment)",
    setup: (s) => { logsOf(s.fulfill).splice(1, 1); logsOf(s.release).splice(1, 1); },
    expect: { V7: ["unknown"], V11: ["unknown"], V13: ["unknown"] }, verdict: "inconclusive",
  },
  {
    name: "Released is missing",
    setup: (s) => { logsOf(s.release).splice(1, 1); },
    expect: { V11: ["unknown"], V12: ["unknown"], V13: ["unknown"] }, verdict: "inconclusive",
  },
  {
    name: "an extra Refunded event exists",
    setup: (s) => {
      s.extraSourceLogs.push(
        eventLog(escrowAbi, "Refunded", { depositId: s.expected.values.depositId, depositor: s.expected.input.payer, token: s.expected.input.sourceAsset, amount: 50_000n }, ESCROW, DEPOSIT_BLOCK + 4n, ZERO32),
      );
    },
    expect: { V12: ["fail"] }, verdict: "fail",
  },
  {
    name: "Deposited.amount exceeds SOURCE_MAX_AMOUNT (51501 > 51500), everything else consistent",
    setup: (s) => {
      replaceWords(s.deposit, [[word(50_000n), word(51_501n)]]);
      replaceWords(s.release, [[word(50_000n), word(51_501n)], [word(49_990n), word(51_491n)]]);
    },
    expect: { V3: ["fail"] }, verdict: "fail",
  },
  {
    name: "the Deposited log comes from another contract (deposit tx given)",
    setup: (s) => {
      logsOf(s.deposit)[1]!.address = OTHER;
      return { omit: ["paymentId"], input: { sourceTx: s.expected.txs.deposit } };
    },
    expect: { V1: ["fail"] }, verdict: "fail",
  },
  {
    name: "the Deposited log comes from another contract (search by payment id; node filters by address)",
    setup: (s) => { logsOf(s.deposit)[1]!.address = OTHER; },
    expect: { V1: ["unknown"] }, verdict: "inconclusive",
  },
  {
    name: "the node ignores the address filter and returns a Deposited from another contract",
    setup: (s) => { logsOf(s.deposit)[1]!.address = OTHER; return { src: { ignoreAddressFilter: true } }; },
    expect: { V1: ["fail"] }, verdict: "fail",
  },
  {
    name: "Fulfilled comes from another contract (node filters by address)",
    setup: (s) => { logsOf(s.fulfill)[1]!.address = OTHER; },
    expect: { V7: ["fail"] }, verdict: "fail",
  },
  {
    name: "the node ignores the address filter and returns a Fulfilled from another contract",
    setup: (s) => { logsOf(s.fulfill)[1]!.address = OTHER; return { dst: { ignoreAddressFilter: true } }; },
    expect: { V7: ["fail"] }, verdict: "fail",
  },
  {
    name: "every eth_getLogs answer is empty (search by payment id)",
    setup: () => ({ src: { emptyLogs: true }, dst: { emptyLogs: true } }),
    expect: { V1: ["unknown"] }, verdict: "inconclusive",
  },
  {
    name: "every eth_getLogs answer is empty (source tx given)",
    setup: (s) => ({ omit: ["paymentId"], input: { sourceTx: s.expected.txs.deposit }, src: { emptyLogs: true }, dst: { emptyLogs: true } }),
    expect: { V7: ["unknown"], V11: ["unknown"], V12: ["unknown"] }, verdict: "inconclusive",
  },
  {
    name: "a batch ReleasedMany event covers the depositId (no single Released)",
    setup: (s) => {
      logsOf(s.release).splice(1, 1);
      s.extraSourceLogs.push(eventLog(escrowAbi, "ReleasedMany", { releaseWitnesses: [witness(s.expected.values.depositId as Hex)] }, ESCROW, DEPOSIT_BLOCK + 3n, s.expected.txs.release));
    },
    expect: { V11: ["unsupported"], V12: ["unsupported"], V14: ["unsupported"] }, verdict: "inconclusive",
  },
  {
    name: "an unrelated batch DepositedMany event appears in the scanned range",
    setup: (s) => {
      s.extraSourceLogs.push(
        eventLog(escrowAbi, "DepositedMany", { depositIds: [ZERO32], depositWitnesses: [{ depositRequestHash: ZERO32, destination: "x", reserver: OTHER, releaser: OTHER }], reserveWitnesses: [{ depositId: ZERO32, quoteHash: ZERO32, settler: OTHER, sourceAmount: 1n }], feeAmounts: [1n] }, ESCROW, DEPOSIT_BLOCK + 2n, ZERO32),
      );
    },
    expect: { V14: ["unsupported"] }, verdict: "inconclusive",
  },
  {
    name: "a batch FulfilledMany event covers the quoteHash (no single Fulfilled)",
    setup: (s) => {
      logsOf(s.fulfill).splice(1, 1);
      s.extraDestLogs.push(
        eventLog(proxyAbi, "FulfilledMany", { fulfillments: [{ quoteHash: s.expected.values.quoteHash, to: OTHER, token: OTHER, amount: 1n }], settler: SETTLER, timestamp: 1n }, PROXY, DEST_BLOCK, s.expected.txs.fulfillment),
      );
    },
    expect: { V7: ["unsupported"], V14: ["unsupported"] }, verdict: "inconclusive",
  },
  {
    name: "the deposit went through depositMany (DepositedMany, no single Deposited)",
    setup: (s) => {
      logsOf(s.deposit).splice(1, 1);
      logsOf(s.deposit).push(
        eventLog(escrowAbi, "DepositedMany", { depositIds: [s.expected.values.depositId], depositWitnesses: [{ depositRequestHash: ZERO32, destination: "x", reserver: OTHER, releaser: OTHER }], reserveWitnesses: [{ depositId: s.expected.values.depositId, quoteHash: s.expected.values.quoteHash, settler: SETTLER, sourceAmount: 1n }], feeAmounts: [1n] }, ESCROW, DEPOSIT_BLOCK, s.expected.txs.deposit),
      );
      return { omit: ["paymentId"], input: { sourceTx: s.expected.txs.deposit } };
    },
    expect: { V1: ["unsupported"], V14: ["unsupported"] }, verdict: "inconclusive",
  },
  {
    name: "Fulfilled.settler differs from Deposited.settler",
    setup: (s) => { (logsOf(s.fulfill)[1]!.topics as string[])[2] = "0x" + addrWord(OTHER); },
    expect: { V10: ["fail"] }, verdict: "fail",
  },
  {
    name: "time order broken: release timestamp earlier than the deposit",
    setup: () => ({ src: { timestampOverrides: { "47751530": 1_791_271_000n } } }),
    expect: { V13: ["fail"] }, verdict: "fail",
  },
  {
    name: "unconfigured source network",
    setup: () => ({ input: { sourceNetwork: "eip155:1" } }),
    expect: Object.fromEntries(CHECKS.map((c) => [c.id, ["unsupported"]])), verdict: "inconclusive",
  },
  {
    name: "the deposit transaction reverted",
    setup: (s) => { s.deposit.status = "0x0"; },
    expect: { V1: ["fail"] }, verdict: "fail",
  },
  {
    name: "the node returns a malformed log",
    setup: () => ({ src: { rawLogsResult: [{ foo: 1 }] } }),
    expect: { V1: ["unknown"] }, verdict: "inconclusive",
  },
  {
    name: "the node fails eth_getLogs with a non-range error",
    setup: () => ({ src: { failMethods: { eth_getLogs: "internal error" } } }),
    expect: { V1: ["unknown"] }, verdict: "inconclusive",
  },
  {
    name: "the node does not know the deposit transaction",
    setup: (s) => ({ omit: ["paymentId"], input: { sourceTx: s.expected.txs.deposit }, src: { nullReceipts: true } }),
    expect: { V1: ["unknown"] }, verdict: "inconclusive",
  },
  {
    name: "the given payment id belongs to a different deposit",
    setup: (s) => {
      return { input: { paymentId: flipLastDigit(s.expected.values.depositId as string) as Hex, sourceTx: s.expected.txs.deposit } };
    },
    expect: { V1: ["fail"] }, verdict: "fail",
  },
  {
    name: "DepositCommitments is missing",
    setup: (s) => { logsOf(s.deposit).splice(2, 1); },
    expect: { V5: ["unknown"], V6: ["unknown"] }, verdict: "inconclusive",
  },
  {
    name: "destinationHash on chain differs",
    setup: (s) => { replaceWords(s.deposit, [[s.expected.values.destinationHash!.slice(2), "ab".repeat(32)]]); },
    expect: { V5: ["fail"] }, verdict: "fail",
  },
  {
    name: "wrong purchase id for the request_id derivation",
    setup: () => ({ input: { purchaseId: "order_00000000000000000000" } }),
    expect: { V6: ["fail"] }, verdict: "fail",
  },
  {
    name: "wrong quote_selector/verifier on chain (reserver differs)",
    setup: (s) => { replaceWords(s.deposit, [[addrWord("0xd0f080E23F95571D26eEb1FAD24a5F3d66835195"), addrWord(OTHER)]], 1); },
    expect: { V4: ["fail"] }, verdict: "fail",
  },
  {
    name: "the escrow never received the tokens (no Transfer in the deposit tx)",
    setup: (s) => { logsOf(s.deposit).splice(0, 1); },
    expect: { V2: ["fail"] }, verdict: "fail",
  },
  {
    name: "the settler was paid the wrong amount on release",
    setup: (s) => { replaceWords(s.release, [[word(49_990n), word(49_989n)]]); },
    expect: { V11: ["fail"] }, verdict: "fail",
  },
];

describe("negative cases: never a pass", () => {
  for (const c of cases) {
    it(c.name, async () => {
      const s = loadSample();
      const extra = c.setup(s) ?? {};
      const r = await run(s, extra as Parameters<typeof run>[1]);
      for (const [id, allowed] of Object.entries(c.expect)) {
        const st = statusOf(r, id);
        expect(st, `${id} (${r.checks.find((x) => x.id === id)?.detail})`).not.toBe("pass");
        expect(allowed, `${id} was "${st}": ${r.checks.find((x) => x.id === id)?.detail}`).toContain(st);
      }
      expect(r.verdict).toBe(c.verdict);
      expect(r.verdict).not.toBe("pass");
      expect(allPass(r)).toBe(false);
    });
  }
});

describe("input validation", () => {
  it("requires a payment id or a source tx", async () => {
    const s = loadSample();
    const { paymentId, ...rest } = baseInput(s);
    void paymentId;
    await expect(verifyPayment(rest as VerifyInput, { readers: makeRig(s).readers, env: {} })).rejects.toBeInstanceOf(InputError);
  });
  it("rejects malformed hashes, addresses and amounts", async () => {
    const s = loadSample();
    const rig = makeRig(s);
    const bad: Partial<VerifyInput>[] = [{ paymentId: "0x1234" as Hex }, { destAddress: "0x12" as Address }, { amount: 0n }, { markupBps: -1n }];
    for (const b of bad) await expect(verifyPayment({ ...baseInput(s), ...b }, { readers: rig.readers, env: {} })).rejects.toBeInstanceOf(InputError);
  });
});
