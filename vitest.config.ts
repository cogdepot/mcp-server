import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: [
        "src/**/*.test.ts",
        // The stdio entrypoint is an adapter: it reads an env var, builds the
        // server and connects a transport. Covering it in-process would mean
        // asserting on the SDK rather than on this package. It is exercised for
        // real by scripts/smoke.mjs, which spawns the built binary - the same
        // split the main repo uses when it excludes cmd/ from its coverage gate.
        "src/stdio.ts",
      ],
      reporter: ["text", "lcov"],
      thresholds: {
        statements: 95,
        branches: 95,
        functions: 95,
        lines: 95,
      },
    },
  },
});
