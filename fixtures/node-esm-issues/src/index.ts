import "./missing.js";

declare const pluginName: string;
declare const require: (name: string) => unknown;

export async function loadPlugin(): Promise<unknown> {
  require("legacy-plugin");
  return import(pluginName);
}
