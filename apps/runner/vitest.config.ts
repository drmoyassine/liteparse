import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // The OCR pipeline test runs real PP-OCRv4 inference when models are present.
    testTimeout: 120_000,
  },
});
