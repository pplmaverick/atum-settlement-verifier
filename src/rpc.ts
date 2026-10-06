import { createPublicClient, http, numberToHex, type Address, type Hex, type Transport } from "viem";
import type { ResolvedNetwork, RpcEndpoint } from "./config/index.js";

/**
 * Thin, read-only RPC layer on viem's public client. Every method returns a Result instead of
 * throwing, so a missing or unparsable answer can only ever surface as "unknown" in a check.
 * Only eth_blockNumber, eth_getBlockByNumber, eth_getTransactionReceipt and eth_getLogs are used.
 */

export type Result<T> = { ok: true; value: T } | { ok: false; reason: string };
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = <T = never>(reason: string): Result<T> => ({ ok: false, reason });

export interface RawLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
  logIndex?: Hex;
}

export interface RawReceipt {
  status: Hex;
  blockNumber: Hex;
  transactionHash: Hex;
  logs: RawLog[];
}

export interface LogQuery {
  address: Address;
  /** Positional topic filter; an inner array means "any of". */
  topics: (Hex | Hex[] | null)[];
  fromBlock: bigint;
  toBlock: bigint;
}

export interface ChainReader {
  readonly caip2: string;
  getBlockNumber(): Promise<Result<bigint>>;
  getBlockTimestamp(block: bigint): Promise<Result<bigint>>;
  /** `ok(null)` means the RPC answered "not found". */
  getReceipt(hash: Hex): Promise<Result<RawReceipt | null>>;
  getLogs(query: LogQuery): Promise<Result<RawLog[]>>;
  /** Smallest block whose timestamp is >= ts, or head+1 when even the head is older. */
  firstBlockAtOrAfter(ts: bigint, head: bigint): Promise<Result<bigint>>;
}

export interface ReaderOptions {
  /** Inject a transport (offline tests). Defaults to viem's http transport with no built-in retries. */
  transportFor?: (endpoint: RpcEndpoint) => Transport;
  /** Max number of window shrinks per getLogs call after the RPC rejects a range. Default 6. */
  maxRangeRetries?: number;
}

export const DEFAULT_MAX_RANGE_RETRIES = 6;

/** Collect every message-like string from an error and its causes. */
export function errorText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur !== null && cur !== undefined; i++) {
    if (typeof cur === "string") {
      parts.push(cur);
      break;
    }
    if (typeof cur !== "object") break;
    const o = cur as { message?: unknown; shortMessage?: unknown; details?: unknown; cause?: unknown };
    for (const k of [o.shortMessage, o.message, o.details]) if (typeof k === "string") parts.push(k);
    cur = o.cause;
  }
  return parts.join(" | ");
}

/** Heuristic for "your block range is too large" errors across providers. */
export function isRangeError(err: unknown): boolean {
  const t = errorText(err).toLowerCase();
  return /range|exceed|too many|too large|too big|limit|more than \d+|max(imum)? (block|result)|query returned/.test(t);
}

const isHex = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v);

function parseRawLog(v: unknown): RawLog | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (!isHex(o.address) || o.address.length !== 42) return undefined;
  if (!Array.isArray(o.topics) || !o.topics.every((t) => isHex(t) && t.length === 66)) return undefined;
  if (!isHex(o.data) || !isHex(o.blockNumber) || !isHex(o.transactionHash)) return undefined;
  if (o.removed === true) return undefined; // a reorged log is not evidence
  return {
    address: o.address as Address,
    topics: o.topics as Hex[],
    data: o.data,
    blockNumber: o.blockNumber,
    transactionHash: o.transactionHash,
    ...(isHex(o.logIndex) ? { logIndex: o.logIndex } : {}),
  };
}

function parseRawReceipt(v: unknown): RawReceipt | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (!isHex(o.status) || !isHex(o.blockNumber) || !isHex(o.transactionHash) || !Array.isArray(o.logs)) return undefined;
  const logs: RawLog[] = [];
  for (const l of o.logs) {
    const p = parseRawLog(l);
    if (!p) return undefined; // one bad log makes the whole receipt untrustworthy
    logs.push(p);
  }
  return { status: o.status, blockNumber: o.blockNumber, transactionHash: o.transactionHash, logs };
}

export function createReader(network: ResolvedNetwork, options: ReaderOptions = {}): ChainReader {
  const maxRangeRetries = options.maxRangeRetries ?? DEFAULT_MAX_RANGE_RETRIES;
  const endpoints = network.rpcs;
  const transportFor = options.transportFor ?? ((e: RpcEndpoint) => http(e.url, { retryCount: 0, timeout: 20_000 }));
  const clients = new Map<string, ReturnType<typeof createPublicClient>>();
  const clientFor = (e: RpcEndpoint) => {
    let c = clients.get(e.url);
    if (!c) {
      c = createPublicClient({ transport: transportFor(e) });
      clients.set(e.url, c);
    }
    return c;
  };
  const noRpc = () => fail<never>(`no RPC configured for ${network.caip2} (set ATUM_VERIFY_RPC_${network.chainId})`);
  const lowestServedBlock = (): bigint =>
    endpoints.length === 0 ? 0n : BigInt(Math.min(...endpoints.map((e) => e.earliestBlock ?? 0)));
  const serves = (e: RpcEndpoint, block: bigint) => block >= BigInt(e.earliestBlock ?? 0);

  async function request(e: RpcEndpoint, method: string, params: unknown[]): Promise<unknown> {
    const client = clientFor(e);
    // The method is a plain string here; viem's typed overloads are bypassed on purpose.
    return (client.request as unknown as (a: { method: string; params: unknown[] }) => Promise<unknown>)({ method, params });
  }

  async function firstOk<T>(usable: (e: RpcEndpoint) => boolean, run: (e: RpcEndpoint) => Promise<Result<T>>): Promise<Result<T>> {
    if (endpoints.length === 0) return noRpc();
    const reasons: string[] = [];
    for (const e of endpoints) {
      if (!usable(e)) {
        reasons.push(`${e.url}: history before block ${e.earliestBlock} is pruned`);
        continue;
      }
      const r = await run(e);
      if (r.ok) return r;
      reasons.push(`${e.url}: ${r.reason}`);
    }
    return fail(reasons.join("; "));
  }

  const reader: ChainReader = {
    caip2: network.caip2,

    async getBlockNumber() {
      return firstOk(() => true, async (e) => {
        try {
          const v = await request(e, "eth_blockNumber", []);
          return isHex(v) ? ok(BigInt(v)) : fail("eth_blockNumber returned a non-hex value");
        } catch (err) {
          return fail(`eth_blockNumber failed: ${errorText(err)}`);
        }
      });
    },

    async getBlockTimestamp(block) {
      return firstOk((e) => serves(e, block), async (e) => {
        try {
          const v = await request(e, "eth_getBlockByNumber", [numberToHex(block), false]);
          if (v === null || v === undefined) return fail(`block ${block} not found`);
          const o = v as { timestamp?: unknown; number?: unknown };
          if (!isHex(o.timestamp) || !isHex(o.number)) return fail(`block ${block}: malformed response`);
          if (BigInt(o.number) !== block) return fail(`block ${block}: RPC returned block ${BigInt(o.number)}`);
          return ok(BigInt(o.timestamp));
        } catch (err) {
          return fail(`eth_getBlockByNumber failed: ${errorText(err)}`);
        }
      });
    },

    async getReceipt(hash) {
      return firstOk(() => true, async (e) => {
        try {
          const v = await request(e, "eth_getTransactionReceipt", [hash]);
          if (v === null || v === undefined) return ok(null);
          const r = parseRawReceipt(v);
          if (!r) return fail("eth_getTransactionReceipt: malformed receipt");
          if (r.transactionHash.toLowerCase() !== hash.toLowerCase()) return fail("eth_getTransactionReceipt: receipt is for a different transaction");
          return ok(r);
        } catch (err) {
          return fail(`eth_getTransactionReceipt failed: ${errorText(err)}`);
        }
      });
    },

    async getLogs(q) {
      if (q.toBlock < q.fromBlock) return ok([]);
      return firstOk((e) => serves(e, q.fromBlock), async (e) => {
        const out: RawLog[] = [];
        let window = BigInt(Math.max(1, e.getLogsMaxRange));
        let shrinks = 0;
        let cursor = q.fromBlock;
        while (cursor <= q.toBlock) {
          const end = cursor + window - 1n > q.toBlock ? q.toBlock : cursor + window - 1n;
          try {
            const v = await request(e, "eth_getLogs", [
              { address: q.address, topics: q.topics, fromBlock: numberToHex(cursor), toBlock: numberToHex(end) },
            ]);
            if (!Array.isArray(v)) return fail("eth_getLogs: result is not an array");
            for (const item of v) {
              const p = parseRawLog(item);
              if (item?.removed === true) continue;
              if (!p) return fail("eth_getLogs: malformed log in response");
              out.push(p);
            }
            cursor = end + 1n;
          } catch (err) {
            if (isRangeError(err) && window > 1n) {
              if (shrinks >= maxRangeRetries) return fail(`eth_getLogs: range rejected after ${shrinks} window shrinks (${errorText(err)})`);
              shrinks += 1;
              window = (window + 1n) / 2n;
              continue;
            }
            return fail(`eth_getLogs failed: ${errorText(err)}`);
          }
        }
        return ok(out);
      });
    },

    async firstBlockAtOrAfter(ts, head) {
      let lo = lowestServedBlock();
      let hi = head;
      const headTs = await reader.getBlockTimestamp(head);
      if (!headTs.ok) return fail(`cannot read head block timestamp: ${headTs.reason}`);
      if (headTs.value < ts) return ok(head + 1n);
      // Invariant: ts(hi) >= ts. Find the smallest block with ts(block) >= ts.
      while (lo < hi) {
        const mid = (lo + hi) / 2n;
        const t = await reader.getBlockTimestamp(mid);
        if (!t.ok) return fail(`block search failed at ${mid}: ${t.reason}`);
        if (t.value >= ts) hi = mid;
        else lo = mid + 1n;
      }
      return ok(lo);
    },
  };
  return reader;
}
