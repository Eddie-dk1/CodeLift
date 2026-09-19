import { cycleA } from "./a.js";

export function cycleB(): string {
  return `b:${cycleA.name}`;
}
