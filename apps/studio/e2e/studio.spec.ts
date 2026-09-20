import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

const destination = path.join(os.tmpdir(), `codelift-e2e-invoice-kit-${process.pid}`);

test.beforeEach(() => {
  fs.rmSync(destination, { recursive: true, force: true });
});

test.afterEach(() => {
  fs.rmSync(destination, { recursive: true, force: true });
});

test("analyzes the configured entrypoint and explains a selected file", async ({ page }) => {
  await page.goto("/#token=e2e-token");
  await expect(page.getByText("Analysis complete")).toBeVisible();
  await expect(page.getByText("5 files included")).toBeVisible();

  await page.getByRole("button", { name: /src\/format\.ts/ }).click();
  await expect(page.getByRole("heading", { name: "Why included" })).toBeVisible();
  await expect(page.getByText(/import \{ formatInvoice \}/)).toBeVisible();
  await expect(page.getByText("Reads environment variable INVOICE_CURRENCY.")).toBeVisible();
});

test("reviews a plan, exports it, and reports unrun install checks honestly", async ({ page }) => {
  await page.goto("/#token=e2e-token");
  await expect(page.getByText("Analysis complete")).toBeVisible();

  await page.getByLabel("Package name").fill("invoice-kit");
  await page.getByLabel("New destination").fill(destination);
  await page.getByLabel(/Accept 3 analysis warnings/).check();
  await page.getByRole("button", { name: "Create plan" }).click();

  await expect(page.getByText("5 files")).toBeVisible();
  await page.getByLabel(/Type invoice-kit to confirm/).fill("invoice-kit");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(page.getByText(/Exported without changing/)).toBeVisible();

  await page.getByRole("button", { name: "Verify package" }).click();
  await expect(page.getByText("Verification: not-run")).toBeVisible();
  await expect(page.getByText("Dependency installation")).toBeVisible();
});
