import { describe, expect, it } from "vitest";
import { EXIT, exitCodeFor, main, parseCli, USAGE } from "../src/cli-main.js";
import { CHECKS } from "../src/checks.js";
import type { ChainReader } from "../src/rpc.js";
import { loadSample, logsOf, makeRig, replaceWords, word, type Sample } from "./helpers/sample.js";

interface Out { code: number; out: string; err: string }

function argsFor(s: Sample, drop: string[] = []): string[] {
  const i = s.expected.input;
  const pairs: [string, string][] = [
    ["--source-network", i.sourceNetwork!],
    ["--dest-network", i.destNetwork!],
    ["--payment-id", i.paymentId!],
    ["--dest-address", i.destAddress!],
    ["--dest-asset", i.destAsset!],
    ["--amount", i.amount!],
    ["--markup-bps", i.markupBps!],
    ["--source-asset", i.sourceAsset!],
    ["--purchase-id", i.purchaseId!],
    ["--payer", i.payer!],
  ];
  return pairs.filter(([f]) => !drop.includes(f)).flat();
}

async function cli(args: string[], s: Sample = loadSample(), readers?: { source: ChainReader; dest: ChainReader }): Promise<Out> {
  let out = "";
  let err = "";
  const code = await main(args, { stdout: (t) => (out += t), stderr: (t) => (err += t) }, { readers: readers ?? makeRig(s).readers, env: {} });
  return { code, out, err };
}

describe("usage errors (exit code 3)", () => {
  const s = loadSample();
  const cases: [string, string[], RegExp][] = [
    ["no arguments", [], /one of --payment-id or --source-tx is required/],
    ["unknown flag", [...argsFor(s), "--private-key", "0x1"], /private-key|Unknown option/i],
    ["a positional argument", [...argsFor(s), "stray"], /positional|Unexpected argument/i],
    ["missing --amount", argsFor(s, ["--amount"]), /missing required option --amount/],
    ["missing --source-network", argsFor(s, ["--source-network"]), /missing required option --source-network/],
    ["missing --dest-network", argsFor(s, ["--dest-network"]), /missing required option --dest-network/],
    ["missing --dest-address", argsFor(s, ["--dest-address"]), /missing required option --dest-address/],
    ["missing --dest-asset", argsFor(s, ["--dest-asset"]), /missing required option --dest-asset/],
    ["neither --payment-id nor --source-tx", argsFor(s, ["--payment-id"]), /one of --payment-id or --source-tx is required/],
    ["a malformed --payment-id", [...argsFor(s, ["--payment-id"]), "--payment-id", "0x1234"], /--payment-id must be a 0x-prefixed 32-byte hash/],
    ["a malformed --dest-address", [...argsFor(s, ["--dest-address"]), "--dest-address", "0xabc"], /--dest-address must be a 0x address/],
    ["a non-numeric --amount", [...argsFor(s, ["--amount"]), "--amount", "12.5"], /--amount must be a non-negative integer/],
    ["a zero --amount", [...argsFor(s, ["--amount"]), "--amount", "0"], /--amount must be greater than zero/],
    ["a negative --markup-bps", [...argsFor(s, ["--markup-bps"]), "--markup-bps", "-1"], /markup-bps|argument/i],
    ["a non-numeric --markup-bps", [...argsFor(s, ["--markup-bps"]), "--markup-bps", "abc"], /--markup-bps must be a non-negative integer/],
    ["a malformed --payer", [...argsFor(s, ["--payer"]), "--payer", "nope"], /--payer must be a 0x address/],
    ["a non-numeric --dest-lookahead-seconds", [...argsFor(s), "--dest-lookahead-seconds", "soon"], /--dest-lookahead-seconds must be a non-negative integer/],
  ];
  for (const [name, args, re] of cases) {
    it(name, async () => {
      const r = await cli(args, s);
      expect(r.code).toBe(EXIT.usage);
      expect(r.err).toMatch(re);
      expect(r.out).toBe("");
    });
  }
});

describe("help and version (exit code 0)", () => {
  it("--help prints the usage including the exit codes", async () => {
    const r = await cli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(USAGE);
    expect(r.out).toMatch(/Exit codes: 0 all checks passed \| 1 a check failed \| 2 inconclusive/);
    expect(r.out).toMatch(/no private key is ever read or needed/);
  });
  it("--version prints the version", async () => {
    const r = await cli(["-v"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^atum-settlement-verifier \d+\.\d+\.\d+\n$/);
  });
});

describe("verification runs", () => {
  it("exit 0 only when every check passed", async () => {
    const r = await cli(argsFor(loadSample()));
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Overall: PASS \(exit code 0\)/);
    expect(r.out).toMatch(/Summary: 15 pass, 0 fail, 0 unknown, 0 unsupported/);
    for (const c of CHECKS) expect(r.out).toContain(c.id);
    expect(r.out).not.toMatch(/Not verified because/);
    expect(r.out).toMatch(/one-cross-chain-sample/);
    expect(r.out).toMatch(/Unofficial, read-only tool; not affiliated with Atum/);
  });

  it("renders the sample-001 report exactly as stored in the offline replay snapshot", async () => {
    const r = await cli(argsFor(loadSample()));
    await expect(r.out).toMatchFileSnapshot("./fixtures/sample-001.cli-output.txt");
  });

  it("accepts --dest-lookahead-seconds and still passes", async () => {
    const r = await cli([...argsFor(loadSample()), "--dest-lookahead-seconds", "600"]);
    expect(r.code).toBe(0);
  });

  it("exit 2 and a list of what a missing option leaves unverified", async () => {
    const r = await cli(argsFor(loadSample(), ["--source-asset", "--purchase-id", "--payer"]));
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/Overall: INCONCLUSIVE \(exit code 2\)/);
    expect(r.out).toMatch(/Not verified because an option was not given:/);
    expect(r.out).toMatch(/V2: add --source-asset/);
    expect(r.out).toMatch(/V6: add --purchase-id and --payer/);
    expect(r.out).not.toMatch(/V6b: add/); // --payment-id was given
  });

  it("names only the option that is actually missing", async () => {
    const r = await cli(argsFor(loadSample(), ["--payer"]));
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/V6: add --purchase-id and --payer|V6: add --payer/);
    expect(r.out).toMatch(/V6: add --payer/);
    expect(r.out).not.toMatch(/V6: add --purchase-id/);
  });

  it("with --source-tx instead of --payment-id, V6b is listed as not verified", async () => {
    const s = loadSample();
    const r = await cli([...argsFor(s, ["--payment-id"]), "--source-tx", s.expected.txs.deposit]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/V6b: add --payment-id/);
  });

  it("exit 1 when a check fails", async () => {
    const s = loadSample();
    replaceWords(s.fulfill, [[word(50_000n), word(49_999n)]]);
    const r = await cli(argsFor(s), s);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Overall: FAIL \(exit code 1\)/);
    expect(r.out).toMatch(/V8 +FAIL/);
  });

  it("exit 2 when a log is missing (unknown) and when a network is unsupported", async () => {
    const s = loadSample();
    logsOf(s.release).splice(1, 1);
    const r1 = await cli(argsFor(s), s);
    expect(r1.code).toBe(2);
    expect(r1.out).toMatch(/V11 +UNKNOWN/);

    const args = argsFor(loadSample(), ["--source-network"]);
    const r2 = await cli([...args, "--source-network", "eip155:1"]);
    expect(r2.code).toBe(2);
    expect(r2.out).toMatch(/UNSUPPORTED/);
    expect(r2.out).toMatch(/network not configured: eip155:1/);
  });

  it("an unexpected exception is exit 2, never 0", async () => {
    const s = loadSample();
    const rig = makeRig(s);
    const boom: ChainReader = { ...rig.readers.source, getBlockNumber: () => Promise.reject(new Error("kaboom")) };
    const r = await cli(argsFor(s), s, { source: boom, dest: rig.readers.dest });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/internal error: kaboom/);
  });

  it("--json prints one JSON document with the verdict, checks, exit code and the missing-option list", async () => {
    const r = await cli([...argsFor(loadSample(), ["--source-asset"]), "--json"]);
    const j = JSON.parse(r.out) as { verdict: string; exitCode: number; checks: { id: string; status: string; support: string }[]; notVerifiedBecauseOptionMissing: { id: string; flags: string[] }[]; tool: string };
    expect(j.tool).toBe("atum-settlement-verifier");
    expect(j.verdict).toBe("inconclusive");
    expect(j.exitCode).toBe(2);
    expect(r.code).toBe(2);
    expect(j.checks).toHaveLength(CHECKS.length);
    expect(j.checks.every((c) => c.support.length > 0)).toBe(true);
    expect(j.notVerifiedBecauseOptionMissing).toEqual([{ id: "V2", flags: ["--source-asset"] }]);
  });

  it("--json for a failure has exitCode 1", async () => {
    const s = loadSample();
    replaceWords(s.fulfill, [[word(50_000n), word(49_999n)]]);
    const r = await cli([...argsFor(s), "--json"], s);
    expect(JSON.parse(r.out).exitCode).toBe(1);
    expect(r.code).toBe(1);
  });
});

describe("secrets", () => {
  it("never reads or prints PRIVATE_KEY, and has no key option", async () => {
    const key = "0x" + "ab".repeat(32);
    const before = process.env.PRIVATE_KEY;
    process.env.PRIVATE_KEY = key;
    try {
      const r = await cli(argsFor(loadSample()));
      expect(r.out + r.err).not.toContain(key);
      expect(r.code).toBe(0);
    } finally {
      if (before === undefined) delete process.env.PRIVATE_KEY;
      else process.env.PRIVATE_KEY = before;
    }
    expect(USAGE).not.toMatch(/--private-key|--key\b|--mnemonic/);
    expect(() => parseCli([...argsFor(loadSample()), "--private-key", key])).toThrow();
  });
});

describe("exit code mapping", () => {
  it("maps verdicts to codes", () => {
    expect(exitCodeFor("pass")).toBe(0);
    expect(exitCodeFor("fail")).toBe(1);
    expect(exitCodeFor("inconclusive")).toBe(2);
    expect(EXIT.usage).toBe(3);
  });
});
