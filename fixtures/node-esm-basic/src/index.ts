import { join } from "node:path";
import type { Invoice } from "@fixture/shared/types.js";
import { createClient } from "@scope/client/http";
import { formatInvoice } from "./format.js";

export { cycleA } from "./cycle/a.js";

export async function renderInvoice(invoice: Invoice): Promise<string> {
  const { formatISO } = await import("date-fns");
  const client = createClient();
  return join(client.basePath, formatISO(invoice.createdAt), formatInvoice(invoice));
}
