import { cycleB } from "./b.js";

export function cycleA(): string {
  return `a:${cycleB.name}`;
}
