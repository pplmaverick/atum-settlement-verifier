import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { decodeLog, isBatchKind } from "../src/decode.js";
import { depositRequestHashOf, deriveX402RequestId, destinationHashOf, destinationString } from "../src/derive.js";
import type { RawLog } from "../src/rpc.js";
import { PROXY, ZERO32, escrowAbi, eventLog, flipLastDigit, loadSample, logsOf, proxyAbi, witness, ESCROW } from "./helpers/sample.js";

const asLog = (j: Record<string, unknown>) => j as unknown as RawLog;

describe("decode", () => {
  const s = loadSample();
  const [transfer, deposited, commitments] = logsOf(s.deposit).map(asLog) as [RawLog, RawLog, RawLog];

  it("decodes the sample's events", () => {
    const d = decodeLog(deposited);
    expect(d.kind).toBe("Deposited");
    if (d.kind === "Deposited") {
      expect(d.args.amount).toBe(50_000n);
      expect(d.args.feeAmount).toBe(10n);
      expect(d.args.quoteHash).toBe(s.expected.values.quoteHash);
      expect(d.args.depositor.toLowerCase()).toBe(s.expected.input.payer?.toLowerCase());
    }
    expect(decodeLog(commitments).kind).toBe("DepositCommitments");
    expect(decodeLog(transfer).kind).toBe("Transfer");
    expect(decodeLog(asLog(logsOf(s.release)[1]!)).kind).toBe("Released");
    expect(decodeLog(asLog(logsOf(s.fulfill)[1]!)).kind).toBe("Fulfilled");
  });

  it("reports unknown topics as unknown, and damaged data as undecodable (never as absent)", () => {
    expect(decodeLog({ ...deposited, topics: [("0x" + "ab".repeat(32)) as Hex] }).kind).toBe("unknown");
    const truncated = decodeLog({ ...deposited, data: deposited.data.slice(0, 66) as Hex });
    expect(truncated.kind).toBe("undecodable");
    const missingTopic = decodeLog({ ...deposited, topics: deposited.topics.slice(0, 3) });
    expect(missingTopic.kind).toBe("undecodable");
  });

  it("decodes the four batch events and lists the ids they contain", () => {
    const id = s.expected.values.depositId as Hex;
    const q = s.expected.values.quoteHash as Hex;
    const O = "0x1111111111111111111111111111111111111111" as const;
    const logs = [
      eventLog(escrowAbi, "DepositedMany", { depositIds: [id], depositWitnesses: [{ depositRequestHash: ZERO32, destination: "x", reserver: O, releaser: O }], reserveWitnesses: [{ depositId: id, quoteHash: q, settler: O, sourceAmount: 1n }], feeAmounts: [1n] }, ESCROW, 1n, ZERO32),
      eventLog(escrowAbi, "ReleasedMany", { releaseWitnesses: [witness(id)] }, ESCROW, 1n, ZERO32),
      eventLog(escrowAbi, "RefundedMany", { refundWitnesses: [witness(id)] }, ESCROW, 1n, ZERO32),
      eventLog(proxyAbi, "FulfilledMany", { fulfillments: [{ quoteHash: q, to: O, token: O, amount: 1n }], settler: O, timestamp: 1n }, PROXY, 1n, ZERO32),
    ];
    const kinds = logs.map((l) => decodeLog(asLog(l)));
    expect(kinds.map((k) => k.kind)).toEqual(["DepositedMany", "ReleasedMany", "RefundedMany", "FulfilledMany"]);
    for (const k of kinds) {
      expect(isBatchKind(k.kind)).toBe(true);
      if (isBatchKind(k.kind)) expect((k as { ids: Hex[] }).ids).toHaveLength(1);
    }
    expect((kinds[3] as { ids: Hex[] }).ids[0]).toBe(q);
  });

  it("a one-digit change in a log must not decode to the same values", () => {
    const changed = decodeLog({ ...deposited, topics: [deposited.topics[0]!, deposited.topics[1]!, flipLastDigit(deposited.topics[2]!) as Hex, deposited.topics[3]!] });
    expect(changed.kind).toBe("Deposited");
    if (changed.kind === "Deposited") expect(changed.args.quoteHash).not.toBe(s.expected.values.quoteHash);
  });
});

describe("derivations (from sample 001)", () => {
  const s = loadSample();
  it("x402 request_id and depositRequestHash", () => {
    const id = deriveX402RequestId(s.expected.input.purchaseId as string, s.expected.input.payer as `0x${string}`);
    expect(id).toBe(s.expected.values.requestId);
    expect(depositRequestHashOf(id)).toBe(s.expected.values.depositRequestHash);
  });
  it("the derivation is case-insensitive in the payer address", () => {
    const p = s.expected.input.payer as `0x${string}`;
    expect(deriveX402RequestId("order_a6516e1fd1be2b9e589f", p.toLowerCase() as `0x${string}`)).toBe(deriveX402RequestId("order_a6516e1fd1be2b9e589f", p));
  });
  it("destination string and hash", () => {
    const i = s.expected.input;
    const str = destinationString(i.destNetwork as string, i.destAsset as `0x${string}`, i.destAddress as `0x${string}`);
    expect(str).toBe(s.expected.values.destinationString);
    expect(destinationHashOf(i.destNetwork as string, i.destAsset as `0x${string}`, i.destAddress as `0x${string}`)).toBe(s.expected.values.destinationHash);
  });
});
