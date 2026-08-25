import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      // Tests consume contracts from TS source; production uses the built dist.
      "@renom/contracts": fileURLToPath(
        new URL("../../../packages/contracts/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["test/**/*.spec.ts"],
    environment: "node",
    hookTimeout: 15000,
    testTimeout: 15000,
  },
});
