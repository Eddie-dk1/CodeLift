import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/test/**/*.test.ts", "apps/**/*.test.{ts,tsx}"],
    coverage: {
      reporter: ["text", "json", "html"],
      include: ["packages/*/src/**/*.ts", "apps/studio/src/**/*.{ts,tsx}"],
    },
  },
});
