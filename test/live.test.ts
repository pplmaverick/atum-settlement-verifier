import { describe, expect, it } from "vitest";
import { verifyPayment } from "../src/verify.js";
import { baseInput, loadSample } from "./helpers/sample.js";

/**
 * Live test: talks to real public RPC endpoints. SKIPPED unless LIVE=1 is set in the environment
 * (`npm run test:live`). The offline guard in test/setup.ts also blocks fetch unless LIVE=1.
 * It re-verifies sample 001 from chain, so it only passes while the public RPCs still serve that history.
 */
describe.skipIf(process.env.LIVE !== "1")("live: sample 001 from public RPCs", () => {
  it("verifies sample 001 end to end", async () => {
    const s = loadSample();
    const r = await verifyPayment({ ...baseInput(s), lookbackBlocks: 20_000n });
    for (const c of r.checks) expect(c.status, `${c.id}: ${c.detail}`).toBe("pass");
    expect(r.verdict).toBe("pass");
  }, 120_000);
});
