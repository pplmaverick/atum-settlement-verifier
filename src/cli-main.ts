import { parseArgs } from "node:util";
import { isAddress, type Address, type Hex } from "viem";
import type { CheckResult, OverallVerdict } from "./types.js";
import { DISCLAIMER, InputError, TOOL_NAME, TOOL_VERSION, verifyPayment, type VerificationReport, type VerifyDeps, type VerifyInput } from "./verify.js";

export const EXIT = { pass: 0, fail: 1, inconclusive: 2, usage: 3 } as const;

export function exitCodeFor(verdict: OverallVerdict): number {
  return verdict === "pass" ? EXIT.pass : verdict === "fail" ? EXIT.fail : EXIT.inconclusive;
}

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

class UsageError extends Error {}

export const USAGE = `${TOOL_NAME} ${TOOL_VERSION} — unofficial, read-only settlement checker (not affiliated with Atum)

Usage:
  atum-verify --source-network <caip2> --dest-network <caip2> \\
              (--payment-id <0x..> | --source-tx <0x..>) \\
              --dest-address <0x..> --dest-asset <0x..> --amount <atomic units> [options]

Required:
  --source-network <caip2>   e.g. eip155:84532
  --dest-network <caip2>     e.g. eip155:421614
  --payment-id <hash>        the payment id (for x402 EVM it equals the escrow depositId), or
  --source-tx <hash>         the source-chain deposit transaction
  --dest-address <address>   expected recipient on the destination chain
  --dest-asset <address>     expected destination token
  --amount <integer>         expected FULFILLMENT_AMOUNT in the destination token's atomic units

Optional (checks that need a missing option are reported as "unknown", never as passed):
  --markup-bps <integer>     markup used to compute the source spend cap (default 300)
  --source-asset <address>   expected source token (V2)
  --purchase-id <string>     with --payer: verify the x402 request_id derivation (V6)
  --payer <address>          the depositor, used with --purchase-id
  --dest-tx <hash>           skip the destination search and read this transaction
  --from-block <n> --to-block <n>   source search window when only --payment-id is given
  --lookback-blocks <n>      source search lookback from the head (default 100000)
  --max-scan-blocks <n>      how far after the deposit to look for Released/Refunded (default 50000)
  --request-delay-ms <n>     minimum gap between RPC requests (default 200)
  --json                     print the report as JSON only
  -h, --help                 show this help
  -v, --version              show the version

Environment (public RPC overrides only; no private key is ever read or needed):
  ATUM_VERIFY_RPC_<chainId>=<url>   ATUM_VERIFY_LOG_RANGE_<chainId>=<blocks>

Exit codes: 0 all checks passed | 1 a check failed | 2 inconclusive (unknown or unsupported) | 3 usage error
`;

const HASH32 = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^\d+$/;

function hash(flag: string, v: string | undefined): Hex | undefined {
  if (v === undefined) return undefined;
  if (!HASH32.test(v)) throw new UsageError(`${flag} must be a 0x-prefixed 32-byte hash`);
  return v as Hex;
}
function address(flag: string, v: string | undefined): Address | undefined {
  if (v === undefined) return undefined;
  if (!isAddress(v, { strict: false })) throw new UsageError(`${flag} must be a 0x address (20 bytes)`);
  return v as Address;
}
function uint(flag: string, v: string | undefined): bigint | undefined {
  if (v === undefined) return undefined;
  if (!UINT.test(v)) throw new UsageError(`${flag} must be a non-negative integer`);
  return BigInt(v);
}
function need<T>(flag: string, v: T | undefined): T {
  if (v === undefined) throw new UsageError(`missing required option ${flag}`);
  return v;
}

export interface ParsedCli {
  help: boolean;
  version: boolean;
  json: boolean;
  requestDelayMs: number;
  input?: VerifyInput;
}

export function parseCli(argv: string[]): ParsedCli {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        "source-network": { type: "string" },
        "dest-network": { type: "string" },
        "payment-id": { type: "string" },
        "source-tx": { type: "string" },
        "dest-tx": { type: "string" },
        "dest-address": { type: "string" },
        "dest-asset": { type: "string" },
        amount: { type: "string" },
        "markup-bps": { type: "string" },
        "source-asset": { type: "string" },
        "purchase-id": { type: "string" },
        payer: { type: "string" },
        "from-block": { type: "string" },
        "to-block": { type: "string" },
        "lookback-blocks": { type: "string" },
        "max-scan-blocks": { type: "string" },
        "request-delay-ms": { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    }));
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  const s = (k: string) => (typeof values[k] === "string" ? (values[k] as string) : undefined);
  const out: ParsedCli = {
    help: values.help === true,
    version: values.version === true,
    json: values.json === true,
    requestDelayMs: Number(uint("--request-delay-ms", s("request-delay-ms")) ?? 200n),
  };
  if (out.help || out.version) return out;

  const paymentId = hash("--payment-id", s("payment-id"));
  const sourceTx = hash("--source-tx", s("source-tx"));
  if (!paymentId && !sourceTx) throw new UsageError("one of --payment-id or --source-tx is required");
  const amount = need("--amount", uint("--amount", s("amount")));
  if (amount <= 0n) throw new UsageError("--amount must be greater than zero");

  const opt = <K extends keyof VerifyInput>(k: K, v: VerifyInput[K] | undefined): Partial<VerifyInput> => (v === undefined ? {} : ({ [k]: v } as Partial<VerifyInput>));
  out.input = {
    sourceNetwork: need("--source-network", s("source-network")),
    destNetwork: need("--dest-network", s("dest-network")),
    destAddress: need("--dest-address", address("--dest-address", s("dest-address"))),
    destAsset: need("--dest-asset", address("--dest-asset", s("dest-asset"))),
    amount,
    ...opt("paymentId", paymentId),
    ...opt("sourceTx", sourceTx),
    ...opt("destTx", hash("--dest-tx", s("dest-tx"))),
    ...opt("markupBps", uint("--markup-bps", s("markup-bps"))),
    ...opt("sourceAsset", address("--source-asset", s("source-asset"))),
    ...opt("purchaseId", s("purchase-id")),
    ...opt("payer", address("--payer", s("payer"))),
    ...opt("fromBlock", uint("--from-block", s("from-block"))),
    ...opt("toBlock", uint("--to-block", s("to-block"))),
    ...opt("lookbackBlocks", uint("--lookback-blocks", s("lookback-blocks"))),
    ...opt("maxScanBlocks", uint("--max-scan-blocks", s("max-scan-blocks"))),
  };
  return out;
}

const LABEL: Record<string, string> = { pass: "PASS", fail: "FAIL", unknown: "UNKNOWN", unsupported: "UNSUPPORTED" };

function missingFlagRows(checks: readonly CheckResult[]): { id: string; flags: string[] }[] {
  return checks.filter((c) => c.status === "unknown" && c.needs && c.needs.length > 0).map((c) => ({ id: c.id, flags: c.needs as string[] }));
}

export function renderText(r: VerificationReport, code: number): string {
  const L: string[] = [];
  const net = (n: VerificationReport["networks"]["source"]) => (n ? `${n.name} (${n.caip2}, ${n.environment})` : "(not configured)");
  L.push(`${TOOL_NAME} ${r.toolVersion}`, `  source: ${net(r.networks.source)}`, `  dest:   ${net(r.networks.dest)}`);
  for (const n of r.notices) L.push(`  ! ${n}`);
  L.push("");
  const idW = Math.max(...r.checks.map((c) => c.id.length));
  const stW = 11;
  const evW = Math.max(...r.checks.map((c) => c.support.length));
  L.push(`${"ID".padEnd(idW)}  ${"STATUS".padEnd(stW)}  ${"EVIDENCE".padEnd(evW)}  CHECK`);
  for (const c of r.checks) {
    L.push(`${c.id.padEnd(idW)}  ${(LABEL[c.status] ?? c.status).padEnd(stW)}  ${c.support.padEnd(evW)}  ${c.description}`);
    L.push(`${" ".repeat(idW + 2)}-> ${c.detail}`);
  }
  const rows = missingFlagRows(r.checks);
  if (rows.length > 0) {
    L.push("", "Not verified because an option was not given:");
    for (const row of rows) L.push(`  ${row.id}: add ${row.flags.join(" and ")}`);
  }
  if (Object.keys(r.facts).length > 0) {
    L.push("", "Read from chain:");
    for (const [k, v] of Object.entries(r.facts)) L.push(`  ${k}: ${v}`);
  }
  const s = r.summary;
  L.push("", `Summary: ${s.pass} pass, ${s.fail} fail, ${s.unknown} unknown, ${s.unsupported} unsupported`);
  L.push(`Overall: ${r.verdict.toUpperCase()} (exit code ${code})`, "", r.disclaimer);
  return L.join("\n") + "\n";
}

export interface MainDeps extends VerifyDeps {}

export async function main(argv: string[], io: CliIo, deps: MainDeps = {}): Promise<number> {
  let cli: ParsedCli;
  try {
    cli = parseCli(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr(`error: ${e.message}\n\nRun with --help for usage.\n`);
      return EXIT.usage;
    }
    throw e;
  }
  if (cli.help) {
    io.stdout(USAGE);
    return EXIT.pass;
  }
  if (cli.version) {
    io.stdout(`${TOOL_NAME} ${TOOL_VERSION}\n`);
    return EXIT.pass;
  }
  try {
    const report = await verifyPayment(cli.input as VerifyInput, { requestDelayMs: cli.requestDelayMs, ...deps });
    const code = exitCodeFor(report.verdict);
    if (cli.json) {
      io.stdout(JSON.stringify({ ...report, notVerifiedBecauseOptionMissing: missingFlagRows(report.checks), exitCode: code }, null, 2) + "\n");
    } else {
      io.stdout(renderText(report, code));
    }
    return code;
  } catch (e) {
    if (e instanceof InputError) {
      io.stderr(`error: ${e.message}\n`);
      return EXIT.usage;
    }
    // An unexpected exception is never a pass: report it as inconclusive.
    io.stderr(`internal error: ${e instanceof Error ? e.message : String(e)}\n${DISCLAIMER}\n`);
    return EXIT.inconclusive;
  }
}
