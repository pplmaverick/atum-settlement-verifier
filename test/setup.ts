// Offline guard: unless the live test is explicitly enabled, any attempt to use fetch fails loudly.
if (process.env.LIVE !== "1") {
  globalThis.fetch = (() => {
    throw new Error("network access is forbidden in offline tests (set LIVE=1 only for test/live.test.ts)");
  }) as unknown as typeof fetch;
}
