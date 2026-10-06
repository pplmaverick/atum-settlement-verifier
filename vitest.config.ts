import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Blocks global fetch unless LIVE=1, so an offline test can never reach a real RPC.
    setupFiles: ["test/setup.ts"],
  },
});
