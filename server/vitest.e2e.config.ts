import { defineConfig } from "vitest/config";

// Tests in a real browser: slower, and they need Chromium and a built web app (see `npm run test:e2e`).
export default defineConfig({
  test: {
    include: ["e2e/**/*.test.ts"],
    testTimeout: 90_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
