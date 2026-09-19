import { expect, test } from "@playwright/test";

test("analyzes the configured entrypoint and explains a selected file", async ({ page }) => {
  await page.goto("/#token=e2e-token");
  await expect(page.getByText("Analysis complete")).toBeVisible();
  await expect(page.getByText("5 files included")).toBeVisible();

  await page.getByRole("button", { name: /src\/format\.ts/ }).click();
  await expect(page.getByRole("heading", { name: "Why included" })).toBeVisible();
  await expect(page.getByText(/import \{ formatInvoice \}/)).toBeVisible();
  await expect(page.getByText("Reads environment variable INVOICE_CURRENCY.")).toBeVisible();
});
