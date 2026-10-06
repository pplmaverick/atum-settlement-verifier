import { isAddress, toEventSelector } from "viem";
import { describe, expect, it } from "vitest";
import { erc20Events, escrowEvents, EXPECTED_TOPIC0, proxyEvents } from "../src/abi.js";
import { CHECKS } from "../src/checks.js";
import { ALL_NETWORKS, OVERRIDE_DEFAULT_RANGE, resolveNetwork } from "../src/config/index.js";
import { overallVerdict, summarize } from "../src/types.js";

describe("network config", () => {
  it("has well-formed addresses and unique CAIP-2 ids", () => {
    const ids = new Set<string>();
    for (const n of ALL_NETWORKS) {
      expect(ids.has(n.caip2)).toBe(false);
      ids.add(n.caip2);
      expect(n.caip2).toBe(`eip155:${n.chainId}`);
      for (const a of [n.escrow, n.fulfillmentProxy, n.quoteSelector, n.fulfillmentVerifier]) {
        expect(isAddress(a, { strict: false })).toBe(true);
      }
    }
  });

  it("marks every mainnet entry experimental and no testnet entry", () => {
    for (const n of ALL_NETWORKS) expect(n.experimental).toBe(n.environment === "mainnet");
  });

  it("keeps testnet and mainnet escrow/proxy sets distinct", () => {
    const t = ALL_NETWORKS.find((n) => n.caip2 === "eip155:84532")!;
    const m = ALL_NETWORKS.find((n) => n.caip2 === "eip155:8453")!;
    expect(t.escrow.toLowerCase()).not.toBe(m.escrow.toLowerCase());
    expect(t.fulfillmentProxy.toLowerCase()).not.toBe(m.fulfillmentProxy.toLowerCase());
  });

  it("returns undefined for unconfigured chains (caller must report unsupported)", () => {
    expect(resolveNetwork("eip155:1", {})).toBeUndefined();
    expect(resolveNetwork("solana:mainnet", {})).toBeUndefined();
  });

  it("applies an RPC override with a conservative default range", () => {
    const r = resolveNetwork("eip155:84532", { ATUM_VERIFY_RPC_84532: "http://localhost:8545" })!;
    expect(r.rpcOverridden).toBe(true);
    expect(r.rpcs).toEqual([{ url: "http://localhost:8545", getLogsMaxRange: OVERRIDE_DEFAULT_RANGE, rangeEvidence: "assumed" }]);
  });

  it("caps configured ranges with ATUM_VERIFY_LOG_RANGE and ignores invalid values", () => {
    const capped = resolveNetwork("eip155:84532", { ATUM_VERIFY_LOG_RANGE_84532: "100" })!;
    expect(capped.rpcs.every((r) => r.getLogsMaxRange <= 100)).toBe(true);
    const ignored = resolveNetwork("eip155:84532", { ATUM_VERIFY_LOG_RANGE_84532: "0" })!;
    expect(ignored.rpcs[0]?.getLogsMaxRange).toBe(50_000);
    const garbage = resolveNetwork("eip155:84532", { ATUM_VERIFY_LOG_RANGE_84532: "12abc" })!;
    expect(garbage.rpcs[0]?.getLogsMaxRange).toBe(50_000);
  });

  it("leaves Tempo mainnet without a default RPC", () => {
    expect(resolveNetwork("eip155:4217", {})!.rpcs).toHaveLength(0);
  });
});

describe("event definitions", () => {
  const all = [...escrowEvents, ...proxyEvents, ...erc20Events];
  it("hash to the topic0 values seen in real logs and the verified ABI", () => {
    for (const [name, topic] of Object.entries(EXPECTED_TOPIC0)) {
      const item = all.find((e) => e.type === "event" && e.name === name);
      expect(item, `event ${name} is defined`).toBeDefined();
      expect(toEventSelector(item as Parameters<typeof toEventSelector>[0])).toBe(topic);
    }
  });
});

describe("result vocabulary", () => {
  it("is fail-closed: anything not pass makes the verdict non-pass", () => {
    expect(overallVerdict(summarize([]))).toBe("inconclusive"); // no checks is never a pass
    expect(overallVerdict({ pass: 3, fail: 0, unknown: 0, unsupported: 0 })).toBe("pass");
    expect(overallVerdict({ pass: 5, fail: 0, unknown: 1, unsupported: 0 })).toBe("inconclusive");
    expect(overallVerdict({ pass: 5, fail: 0, unknown: 0, unsupported: 1 })).toBe("inconclusive");
    expect(overallVerdict({ pass: 5, fail: 1, unknown: 1, unsupported: 1 })).toBe("fail");
  });

  it("has unique check ids", () => {
    expect(new Set(CHECKS.map((c) => c.id)).size).toBe(CHECKS.length);
  });
});
