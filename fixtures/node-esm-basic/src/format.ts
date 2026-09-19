import { readFileSync } from "node:fs";
import { cycleA } from "./cycle/a.js";
import type { Invoice } from "./shared/types.js";

export function formatInvoice(invoice: Invoice): string {
  const currency = process.env.INVOICE_CURRENCY ?? "USD";
  const template = readFileSync("./template.txt", "utf8");
  const locale = Reflect.get(globalThis, "applicationLocale") ?? "en";
  return `${template}:${locale}:${currency}:${invoice.total}:${cycleA()}`;
}
