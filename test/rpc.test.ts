import { toHex, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { resolveNetwork, type ResolvedNetwork } from "../src/config/index.js";
import { createReader, errorText, isRangeError } from "../src/rpc.js";
import { FakeChain } from "./helpers/fake-chain.js";

const ADDR = "0x0F875601504C9179562506AFa34b2D084268869b" as Address;
const TOPIC = ("0x" + "11".repeat(32)) as Hex;

/** One log per block from 1000 to 1999. */
const logs = Array.from({ length: 1000 }, (_, i) => ({
  address: ADDR.toLowerCase(),
  topics: [TOPIC],
  data: "0x",
  blockNumber: toHex(1000 + i),
  transactionHash: ("0x" + i.toString(16).padStart(64, "0")) as Hex,
  logIndex: "0x0",
}));

const chain = (over: Partial<ConstructorParameters<typeof FakeChain>[0]> = {}) =>
  new FakeChain({ receipts: [], extraLogs: logs, head: 2000n, anchorBlock: 1000n, anchorTs: 10_000n, secondsPerBlock: 2, ...over });

function network(range: number, extra: Partial<ResolvedNetwork> = {}): ResolvedNetwork {
  const base = resolveNetwork("eip155:84532", {})!;
  return { ...base, rpcs: [{ url: "http://fake.invalid", getLogsMaxRange: range, rangeEvidence: "assumed" }], ...extra };
}

const query = { address: ADDR, topics: [TOPIC], fromBlock: 1000n, toBlock: 1999n };

describe("getLogs windowing", () => {
  it("splits a long range into windows no larger than the configured limit and returns every log once", async () => {
    const c = chain({ maxLogRange: 100n });
    const r = await createReader(network(100), { transportFor: () => c.transport() }).getLogs(query);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toHaveLength(1000);
    const ranges = c.getLogCalls();
    expect(ranges).toHaveLength(10);
    for (const x of ranges) expect(x.toBlock - x.fromBlock + 1n).toBeLessThanOrEqual(100n);
  });

  it("shrinks the window and retries when the node rejects the range", async () => {
    const c = chain({ maxLogRange: 100n });
    const r = await createReader(network(500), { transportFor: () => c.transport() }).getLogs(query);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toHaveLength(1000);
      expect(new Set(r.value.map((l) => l.transactionHash)).size).toBe(1000);
    }
    // 500 -> 250 -> 125 -> 63: three rejected requests before it fits.
    const rejected = c.getLogCalls().filter((x) => x.toBlock - x.fromBlock + 1n > 100n);
    expect(rejected).toHaveLength(3);
  });

  it("gives up after a bounded number of shrinks and reports why", async () => {
    const c = chain({ maxLogRange: 2n });
    const r = await createReader(network(100_000), { transportFor: () => c.transport(), maxRangeRetries: 4 }).getLogs(query);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/range rejected after 4 window shrinks/);
    expect(c.getLogCalls()).toHaveLength(5); // the first attempt + 4 retries, then it stops
  });

  it("does not retry non-range errors", async () => {
    const c = chain({ failMethods: { eth_getLogs: "internal error" } });
    const r = await createReader(network(500), { transportFor: () => c.transport() }).getLogs(query);
    expect(r.ok).toBe(false);
    expect(c.calls.filter((x) => x.method === "eth_getLogs")).toHaveLength(1);
  });

  it("falls back to the next endpoint when the first one fails", async () => {
    const bad = chain({ failMethods: { eth_getLogs: "boom" } });
    const good = chain();
    const base = resolveNetwork("eip155:84532", {})!;
    const net: ResolvedNetwork = {
      ...base,
      rpcs: [
        { url: "http://bad.invalid", getLogsMaxRange: 500, rangeEvidence: "assumed" },
        { url: "http://good.invalid", getLogsMaxRange: 500, rangeEvidence: "assumed" },
      ],
    };
    const r = await createReader(net, { transportFor: (e) => (e.url.includes("bad") ? bad : good).transport() }).getLogs(query);
    expect(r.ok).toBe(true);
    expect(bad.calls.length).toBeGreaterThan(0);
  });

  it("skips an endpoint whose pruned history does not reach the requested block", async () => {
    const pruned = chain();
    const full = chain();
    const base = resolveNetwork("eip155:84532", {})!;
    const net: ResolvedNetwork = {
      ...base,
      rpcs: [
        { url: "http://pruned.invalid", getLogsMaxRange: 500, rangeEvidence: "assumed", earliestBlock: 5000 },
        { url: "http://full.invalid", getLogsMaxRange: 500, rangeEvidence: "assumed" },
      ],
    };
    const r = await createReader(net, { transportFor: (e) => (e.url.includes("pruned") ? pruned : full).transport() }).getLogs(query);
    expect(r.ok).toBe(true);
    expect(pruned.calls).toHaveLength(0);
  });

  it("reports failure (never an empty success) when every endpoint is unusable", async () => {
    const pruned = chain();
    const base = resolveNetwork("eip155:84532", {})!;
    const net: ResolvedNetwork = { ...base, rpcs: [{ url: "http://pruned.invalid", getLogsMaxRange: 500, rangeEvidence: "assumed", earliestBlock: 5000 }] };
    const r = await createReader(net, { transportFor: () => pruned.transport() }).getLogs(query);
    expect(r.ok).toBe(false);
  });

  it("drops reorged (removed) logs and rejects malformed ones", async () => {
    const withRemoved = chain({ rawLogsResult: [{ ...logs[0], removed: true }, logs[1]] });
    const r1 = await createReader(network(500), { transportFor: () => withRemoved.transport() }).getLogs({ ...query, toBlock: 1100n });
    expect(r1.ok && r1.value.length).toBe(1);
    const malformed = chain({ rawLogsResult: [{ ...logs[0], topics: ["0x12"] }] });
    const r2 = await createReader(network(500), { transportFor: () => malformed.transport() }).getLogs({ ...query, toBlock: 1100n });
    expect(r2.ok).toBe(false);
  });

  it("an empty range is a successful empty answer without any request", async () => {
    const c = chain();
    const r = await createReader(network(500), { transportFor: () => c.transport() }).getLogs({ ...query, fromBlock: 10n, toBlock: 9n });
    expect(r).toEqual({ ok: true, value: [] });
    expect(c.calls).toHaveLength(0);
  });
});

describe("other reads", () => {
  it("returns ok(null) for an unknown receipt", async () => {
    const reader = createReader(network(500), { transportFor: () => chain().transport() });
    expect(await reader.getReceipt(TOPIC)).toEqual({ ok: true, value: null });
  });

  it("fails when the node answers with another transaction's receipt or a malformed one", async () => {
    const other = { status: "0x1", blockNumber: "0x1", transactionHash: "0x" + "22".repeat(32), logs: [] };
    const wrongTx = createReader(network(500), { transportFor: () => chain({ receiptResult: other }).transport() });
    const r1 = await wrongTx.getReceipt(TOPIC);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toMatch(/different transaction/);

    const malformed = createReader(network(500), { transportFor: () => chain({ receiptResult: { status: "0x1" } }).transport() });
    expect((await malformed.getReceipt(TOPIC)).ok).toBe(false);

    const badLog = { ...other, transactionHash: TOPIC, logs: [{ address: "nope" }] };
    const badLogReader = createReader(network(500), { transportFor: () => chain({ receiptResult: badLog }).transport() });
    expect((await badLogReader.getReceipt(TOPIC)).ok).toBe(false);
  });

  it("finds the first block at or after a timestamp, and head+1 when none exists", async () => {
    const c = chain({ head: 2000n });
    const reader = createReader(network(500), { transportFor: () => c.transport() });
    // ts(n) = 10000 + 2 * (n - 1000)
    expect(await reader.firstBlockAtOrAfter(10_000n, 2000n)).toEqual({ ok: true, value: 1000n });
    expect(await reader.firstBlockAtOrAfter(10_001n, 2000n)).toEqual({ ok: true, value: 1001n });
    expect(await reader.firstBlockAtOrAfter(12_000n, 2000n)).toEqual({ ok: true, value: 2000n });
    expect(await reader.firstBlockAtOrAfter(99_999n, 2000n)).toEqual({ ok: true, value: 2001n });
  });

  it("returns a failure instead of throwing when the node is down", async () => {
    const c = chain({ failMethods: { eth_blockNumber: "connection refused", eth_getBlockByNumber: "connection refused" } });
    const reader = createReader(network(500), { transportFor: () => c.transport() });
    const head = await reader.getBlockNumber();
    expect(head.ok).toBe(false);
    expect((await reader.getBlockTimestamp(5n)).ok).toBe(false);
    expect((await reader.firstBlockAtOrAfter(1n, 100n)).ok).toBe(false);
  });

  it("an endpoint list that is empty is a failure with a hint, not a crash", async () => {
    const reader = createReader({ ...network(500), rpcs: [] });
    const r = await reader.getBlockNumber();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/ATUM_VERIFY_RPC_84532/);
  });
});

describe("error classification", () => {
  it("recognises provider range errors and nothing unrelated", () => {
    for (const m of ["eth_getLogs is limited to a 500 range", "exceed maximum block range: 50000", "query returned more than 10000 results", "block range too large"]) {
      expect(isRangeError(new Error(m)), m).toBe(true);
    }
    for (const m of ["connection refused", "internal error", "invalid params"]) expect(isRangeError(new Error(m)), m).toBe(false);
  });
  it("collects messages from nested causes", () => {
    expect(errorText(new Error("outer", { cause: new Error("inner detail") }))).toContain("inner detail");
  });
});
