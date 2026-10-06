import { describe, expect, it } from "vitest";
import { verifyPayment } from "../src/verify.js";
import { baseInput, loadSample } from "./helpers/sample.js";

/**
 * Live test: talks to real public RPC endpoints (Base Sepolia and Arbitrum Sepolia, read-only).
 * SKIPPED unless LIVE=1 is set in the environment (`npm run test:live`). The offline guard in
 * test/setup.ts also blocks fetch unless LIVE=1.
 *
 * It re-verifies sample 001 from chain with small windows and paced requests, so it only passes while
 * the public RPCs still serve that history and the sample is within the lookback window.
 */
describe.skipIf(process.env.LIVE !== "1")("live: sample 001 from public RPCs", () => {
  it("verifies sample 001 end to end", async () => {
    const s = loadSample();
    const r = await verifyPayment(
      { ...baseInput(s), lookbackBlocks: 40_000n, destLookaheadSeconds: 600n },
      { requestDelayMs: 400 },
    );
    for (const c of r.checks) expect(c.status, `${c.id}: ${c.detail}`).toBe("pass");
    expect(r.verdict).toBe("pass");
    expect(r.facts.depositTx).toBe(s.expected.txs.deposit);
    expect(r.facts.fulfillmentTx).toBe(s.expected.txs.fulfillment);
  }, 180_000);
});
