import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/studio/e2e",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4317",
    trace: "on-first-retry",
  },
  webServer: {
    command:
      "node packages/studio-server/dist/dev.js --project fixtures/node-esm-basic --entry src/index.ts --port 4317 --token e2e-token",
    port: 4317,
    reuseExistingServer: !process.env.CI,
  },
});
