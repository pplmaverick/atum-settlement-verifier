import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Json, loadSample, logsOf } from "./helpers/sample.js";

const read = (rel: string): Json => JSON.parse(readFileSync(new URL(`./fixtures/${rel}`, import.meta.url), "utf8")) as Json;
const lc = (v: unknown): string => String(v).toLowerCase();

/** Fields compared between a reconstructed and a real log. The others (logIndex, blockHash, transactionIndex, blockTimestamp) are placeholders in the reconstruction. */
const SEMANTIC = ["address", "topics", "data", "blockNumber", "transactionHash"] as const;

function diffReceipts(label: string, rebuilt: Json, real: Json): string[] {
  const out: string[] = [];
  for (const k of ["status", "blockNumber", "transactionHash", "from", "to"] as const) {
    if (lc(rebuilt[k]) !== lc(real[k])) out.push(`${label}: ${k} differs (${String(rebuilt[k])} vs ${String(real[k])})`);
  }
  const a = logsOf(rebuilt);
  const b = logsOf(real);
  if (a.length !== b.length) out.push(`${label}: ${a.length} logs vs ${b.length}`);
  a.forEach((la, i) => {
    const lb = b[i];
    if (!lb) return;
    for (const k of SEMANTIC) {
      if (JSON.stringify(la[k]).toLowerCase() !== JSON.stringify(lb[k]).toLowerCase()) out.push(`${label}: log ${i} ${k} differs`);
    }
  });
  return out;
}

describe("real captured fixtures vs the reconstructed ones", () => {
  it("agree on every semantic field of every log (placeholders excluded)", () => {
    const diffs = [
      ...diffReceipts("deposit", read("reconstructed/base-sepolia.deposit-receipt.json"), read("real/base-sepolia.deposit-receipt.json")),
      ...diffReceipts("release", read("reconstructed/base-sepolia.release-receipt.json"), read("real/base-sepolia.release-receipt.json")),
      ...diffReceipts("fulfillment", read("reconstructed/arbitrum-sepolia.fulfill-receipt.json"), read("real/arbitrum-sepolia.fulfill-receipt.json")),
    ];
    expect(diffs).toEqual([]);
  });

  it("the placeholder fields in the reconstruction do differ from the real ones (so this comparison is not vacuous)", () => {
    const rebuilt = logsOf(read("reconstructed/base-sepolia.release-receipt.json"));
    const real = logsOf(read("real/base-sepolia.release-receipt.json"));
    expect(rebuilt[0]!.logIndex).not.toBe(real[0]!.logIndex);
  });
});

describe("real captured fixtures vs the recorded sample values", () => {
  const s = loadSample();
  const meta = read("real/capture-meta.json") as {
    blocks: Record<string, { number: string; timestamp: string }>;
    counts: { escrowLogs: number; proxyLogs: number };
  };

  it("block numbers and timestamps equal the values in the analysis notes", () => {
    const t = s.expected.timeline;
    expect(Number(BigInt(meta.blocks.deposit!.number))).toBe(t.depositBlock);
    expect(Number(BigInt(meta.blocks.deposit!.timestamp))).toBe(t.depositTimestamp);
    expect(Number(BigInt(meta.blocks.release!.number))).toBe(t.releaseBlock);
    expect(Number(BigInt(meta.blocks.release!.timestamp))).toBe(t.releaseTimestamp);
    expect(Number(BigInt(meta.blocks.fulfillment!.number))).toBe(t.fulfillmentBlock);
    expect(Number(BigInt(meta.blocks.fulfillment!.timestamp))).toBe(t.fulfillmentTimestamp);
  });

  it("transaction hashes equal the sample's", () => {
    expect(s.deposit.transactionHash).toBe(s.expected.txs.deposit);
    expect(s.release.transactionHash).toBe(s.expected.txs.release);
    expect(s.fulfill.transactionHash).toBe(s.expected.txs.fulfillment);
  });

  it("the unfiltered eth_getLogs answers contain exactly the same logs as the receipts (same node, same objects)", () => {
    const escrow = read("real/base-sepolia.escrow-logs.json") as unknown as Json[];
    const fromReceipts = [...logsOf(s.deposit), ...logsOf(s.release)].filter((l) => lc(l.address) === "0x0f875601504c9179562506afa34b2d084268869b");
    expect(escrow).toEqual(fromReceipts);
    const proxy = read("real/arbitrum-sepolia.proxy-logs.json") as unknown as Json[];
    const proxyFromReceipt = logsOf(s.fulfill).filter((l) => lc(l.address) === "0x1f1f8fa642bc5f530ba37f1db3a656e9eb8bafeb");
    expect(meta.counts).toEqual({ escrowLogs: 3, proxyLogs: 1 });
    // Observed quirk of the Arbitrum Sepolia public RPC: eth_getLogs reports blockTimestamp "0x0" while the
    // receipt carries the real value. The verifier never reads that field (timestamps come from eth_getBlockByNumber).
    expect(proxy).toHaveLength(1);
    expect(proxy[0]!.blockTimestamp).toBe("0x0");
    expect(proxyFromReceipt[0]!.blockTimestamp).toBe("0x6ac4a1af");
    const { blockTimestamp: _a, ...proxyRest } = proxy[0]!;
    const { blockTimestamp: _b, ...receiptRest } = proxyFromReceipt[0]!;
    void _a; void _b;
    expect(proxyRest).toEqual(receiptRest);
  });

  it("contains no local paths or secrets", () => {
    const names = ["base-sepolia.deposit-receipt", "base-sepolia.release-receipt", "arbitrum-sepolia.fulfill-receipt", "base-sepolia.escrow-logs", "arbitrum-sepolia.proxy-logs", "capture-meta"];
    for (const n of names) {
      const text = readFileSync(new URL(`./fixtures/real/${n}.json`, import.meta.url), "utf8");
      expect(text, n).not.toMatch(/\/Users\/|\/private\/|pplmaverick|privateKey|PRIVATE_KEY/i);
    }
  });
});
