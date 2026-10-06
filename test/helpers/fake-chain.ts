import { custom, toHex, type Transport } from "viem";

type Json = Record<string, unknown>;

export interface FakeChainOptions {
  /** Receipts the chain "knows". The logs inside them are also what eth_getLogs searches. */
  receipts: Json[];
  /** Additional standalone logs for eth_getLogs only. */
  extraLogs?: Json[];
  head: bigint;
  /** Linear block-time model through one (block, timestamp) anchor. */
  anchorBlock: bigint;
  anchorTs: bigint;
  secondsPerBlock: number;
  timestampOverrides?: Record<string, bigint>;
  /** Reject eth_getLogs ranges wider than this, with a provider-style error. */
  maxLogRange?: bigint;
  /** Misbehaving-RPC switches. */
  ignoreAddressFilter?: boolean;
  /** Ignore topic positions >= 1 (return logs for other ids too). */
  ignoreTopicFilter?: boolean;
  emptyLogs?: boolean;
  nullReceipts?: boolean;
  /** Answer every eth_getTransactionReceipt with this value, whatever hash was asked for. */
  receiptResult?: unknown;
  /** Return this instead of the log array. */
  rawLogsResult?: unknown;
  /** method -> error message to throw. */
  failMethods?: Record<string, string>;
}

/** An in-memory JSON-RPC node. Any method it does not implement throws, so tests cannot silently depend on more. */
export class FakeChain {
  readonly calls: { method: string; params: unknown[] }[] = [];
  constructor(readonly opts: FakeChainOptions) {}

  tsOf(n: bigint): bigint {
    const o = this.opts.timestampOverrides?.[n.toString()];
    if (o !== undefined) return o;
    return this.opts.anchorTs + BigInt(Math.floor(Number(n - this.opts.anchorBlock) * this.opts.secondsPerBlock));
  }

  private allLogs(): Json[] {
    const fromReceipts = this.opts.receipts.flatMap((r) => (r.logs as Json[]) ?? []);
    return [...fromReceipts, ...(this.opts.extraLogs ?? [])];
  }

  getLogCalls(): { fromBlock: bigint; toBlock: bigint }[] {
    return this.calls
      .filter((c) => c.method === "eth_getLogs")
      .map((c) => {
        const f = (c.params[0] ?? {}) as { fromBlock: string; toBlock: string };
        return { fromBlock: BigInt(f.fromBlock), toBlock: BigInt(f.toBlock) };
      });
  }

  private handle(method: string, params: unknown[]): unknown {
    this.calls.push({ method, params });
    const fm = this.opts.failMethods?.[method];
    if (fm) throw new Error(fm);

    switch (method) {
      case "eth_blockNumber":
        return toHex(this.opts.head);
      case "eth_getBlockByNumber": {
        const n = BigInt(params[0] as string);
        if (n > this.opts.head) return null;
        return { number: toHex(n), timestamp: toHex(this.tsOf(n)) };
      }
      case "eth_getTransactionReceipt": {
        if (this.opts.receiptResult !== undefined) return this.opts.receiptResult;
        if (this.opts.nullReceipts) return null;
        const h = String(params[0]).toLowerCase();
        return this.opts.receipts.find((r) => String(r.transactionHash).toLowerCase() === h) ?? null;
      }
      case "eth_getLogs": {
        const f = params[0] as { address?: string | string[]; topics?: (string | string[] | null)[]; fromBlock: string; toBlock: string };
        const from = BigInt(f.fromBlock);
        const to = BigInt(f.toBlock);
        if (this.opts.maxLogRange !== undefined && to - from + 1n > this.opts.maxLogRange) {
          throw Object.assign(new Error(`eth_getLogs is limited to a ${this.opts.maxLogRange} range`), { code: -32614 });
        }
        if (this.opts.rawLogsResult !== undefined) return this.opts.rawLogsResult;
        if (this.opts.emptyLogs) return [];
        const addrs = (Array.isArray(f.address) ? f.address : f.address ? [f.address] : []).map((a) => a.toLowerCase());
        return this.allLogs().filter((l) => {
          const b = BigInt(l.blockNumber as string);
          if (b < from || b > to) return false;
          if (!this.opts.ignoreAddressFilter && addrs.length > 0 && !addrs.includes(String(l.address).toLowerCase())) return false;
          const topics = l.topics as string[];
          const want = f.topics ?? [];
          for (let i = 0; i < want.length; i++) {
            if (this.opts.ignoreTopicFilter && i > 0) continue;
            const w = want[i];
            if (w === null || w === undefined) continue;
            const have = topics[i]?.toLowerCase();
            const ok = Array.isArray(w) ? w.some((x) => x.toLowerCase() === have) : w.toLowerCase() === have;
            if (!ok) return false;
          }
          return true;
        });
      }
      default:
        throw new Error(`FakeChain: unexpected RPC method ${method}`);
    }
  }

  transport(): Transport {
    return custom(
      {
        request: async ({ method, params }: { method: string; params?: unknown }) =>
          structuredClone(this.handle(method, (params as unknown[]) ?? [])),
      },
      { retryCount: 0 },
    );
  }
}
