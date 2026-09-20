import { basename } from "node:path";
import { normalizeLabel } from "./normalize.js";

export function fileLabel(fileName: string): string {
  return normalizeLabel(basename(fileName));
}
