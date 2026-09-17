import { defineConfig } from "vitest/config";

export default defineConfig({
  // No resolve.alias: @renom/contracts resolves through the npm workspace
  // symlink to packages/contracts/dist (built before tests run — see the
  // root "test" script). Tests therefore exercise the artifact that ships.
  test: {
    include: ["test/**/*.spec.ts"],
    environment: "node",
    hookTimeout: 15000,
    testTimeout: 15000,
  },
});
