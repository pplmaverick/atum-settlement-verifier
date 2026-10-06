import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Json, loadSample, logsOf } from "./helpers/sample.js";

const read = (rel: string): Json => JSON.parse(readFileSync(new URL(`./fixtures/${rel}`, import.meta.url), "utf8")) as Json;
const lc = (v: unknown): string => String(v).toLowerCase();

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
