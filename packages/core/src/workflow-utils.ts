import { createHash } from "node:crypto";
import fs from "node:fs";
import type { ExtractionPlan } from "./workflow-types.js";

export function sha256(value: string | NodeJS.ArrayBufferView): string {
  return createHash("sha256").update(value).digest("hex");
}

export function digestFile(fileName: string): string {
  return sha256(fs.readFileSync(fileName));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortValue(nested)]),
    );
  }
  return value;
}

export function stableJson(value: unknown, spacing = 2): string {
  return `${JSON.stringify(sortValue(value), null, spacing)}\n`;
}

export function digestExtractionPlan(
  plan: Omit<ExtractionPlan, "digest"> | ExtractionPlan,
): string {
  const portable = structuredClone(plan) as Partial<ExtractionPlan> &
    Pick<ExtractionPlan, "source" | "analysis">;
  delete portable.digest;
  portable.source.root = "<source-root>";
  portable.analysis.project.root = "<source-root>";
  return sha256(stableJson(portable));
}
