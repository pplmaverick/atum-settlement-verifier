import { readFileSync } from "node:fs";
import { parseAbi, toEventSelector, type AbiEvent } from "viem";
import { describe, expect, it } from "vitest";
import { erc20Events, escrowEvents, EXPECTED_TOPIC0, proxyEvents } from "../src/abi.js";

const load = (name: string): AbiEvent[] =>
  (JSON.parse(readFileSync(new URL(`./fixtures/abi/${name}`, import.meta.url), "utf8")) as { type: string }[]).filter(
    (i): i is AbiEvent => i.type === "event",
  );

interface Mismatch { event: string; problem: string }

/** Compare hand-written events against the full ABI: topic0, and each input's type, name and indexed flag. */
export function compareEvents(hand: readonly AbiEvent[], full: readonly AbiEvent[]): Mismatch[] {
  const out: Mismatch[] = [];
  for (const h of hand) {
    const f = full.find((x) => x.name === h.name);
    if (!f) {
      out.push({ event: h.name, problem: "not present in the full ABI" });
      continue;
    }
    if (toEventSelector(h) !== toEventSelector(f)) out.push({ event: h.name, problem: `topic0 ${toEventSelector(h)} != ${toEventSelector(f)}` });
    if (h.inputs.length !== f.inputs.length) {
      out.push({ event: h.name, problem: "different number of inputs" });
      continue;
    }
    h.inputs.forEach((hi, i) => {
      const fi = f.inputs[i]!;
      if (hi.name !== fi.name) out.push({ event: h.name, problem: `input ${i} name ${hi.name} != ${fi.name}` });
      if (Boolean(hi.indexed) !== Boolean(fi.indexed)) out.push({ event: h.name, problem: `input ${hi.name} indexed flag differs` });
    });
  }
  return out;
}

const handEvents = (abi: ReturnType<typeof parseAbi>) => abi.filter((i): i is AbiEvent => i.type === "event");

describe("hand-written event signatures vs the full published ABI", () => {
  for (const env of ["testnet", "mainnet"] as const) {
    it(`escrow events match the ${env} ABI`, () => {
      expect(compareEvents(handEvents(escrowEvents), load(`escrow.${env}.abi.json`))).toEqual([]);
    });
    it(`fulfillment proxy events match the ${env} ABI`, () => {
      expect(compareEvents(handEvents(proxyEvents), load(`fulfillment-proxy.${env}.abi.json`))).toEqual([]);
    });
  }

  it("covers every escrow/proxy event the verifier relies on", () => {
    const names = [...handEvents(escrowEvents), ...handEvents(proxyEvents)].map((e) => e.name).sort();
    expect(names).toEqual(["DepositCommitments", "Deposited", "DepositedMany", "Fulfilled", "FulfilledMany", "Refunded", "RefundedMany", "Released", "ReleasedMany"]);
  });

  it("topic0 constants equal the selectors generated from the full ABI JSON", () => {
    const full = [...load("escrow.testnet.abi.json"), ...load("fulfillment-proxy.testnet.abi.json")];
    for (const [name, topic] of Object.entries(EXPECTED_TOPIC0)) {
      if (name === "Transfer") continue; // not part of the Atum contracts' own ABI
      const item = full.find((e) => e.name === name);
      expect(item, `${name} in full ABI`).toBeDefined();
      expect(toEventSelector(item as AbiEvent)).toBe(topic);
    }
    expect(toEventSelector(handEvents(erc20Events)[0] as AbiEvent)).toBe(EXPECTED_TOPIC0.Transfer);
  });

  it("testnet and mainnet ABIs agree on every event the verifier uses", () => {
    const names = ["Deposited", "DepositCommitments", "Released", "Refunded", "Fulfilled"];
    for (const [t, m] of [["escrow.testnet.abi.json", "escrow.mainnet.abi.json"], ["fulfillment-proxy.testnet.abi.json", "fulfillment-proxy.mainnet.abi.json"]] as const) {
      const a = load(t);
      const b = load(m);
      for (const n of names) {
        const ea = a.find((e) => e.name === n);
        const eb = b.find((e) => e.name === n);
        if (!ea && !eb) continue;
        expect(ea && toEventSelector(ea)).toBe(eb && toEventSelector(eb));
      }
    }
  });

  it("the guard itself detects a wrong type, a wrong indexed flag and a missing event", () => {
    const full = load("escrow.testnet.abi.json");
    const wrongType = handEvents(parseAbi(["event Released(bytes32 indexed depositId, address indexed settler, address token, uint128 amount, uint256 feeAmount)"]));
    expect(compareEvents(wrongType, full).length).toBeGreaterThan(0);
    const wrongIndexed = handEvents(parseAbi(["event Released(bytes32 indexed depositId, address settler, address token, uint256 amount, uint256 feeAmount)"]));
    expect(compareEvents(wrongIndexed, full).length).toBeGreaterThan(0);
    const missing = handEvents(parseAbi(["event NotARealEvent(uint256 x)"]));
    expect(compareEvents(missing, full)).toEqual([{ event: "NotARealEvent", problem: "not present in the full ABI" }]);
  });
});
