import { trim } from "@lib/trim.js";

export function normalize(value: string) {
  return trim(value).toLowerCase();
}
