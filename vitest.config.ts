import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pure-logic tests run in node by default; canvas/DOM tests opt in with a
    // `// @vitest-environment jsdom` pragma at the top of the file.
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      include: ["src/**/*.ts"],
      exclude: ["src/examples/**", "src/**/none.ts"],
    },
  },
});
