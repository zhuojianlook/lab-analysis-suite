// Loads the IronCalc wasm in node for the Scratchpad tests (same bootstrap as readonly.sheet.test.ts).
import { initSync } from "@ironcalc/wasm";

// node:fs / node:module, loaded only in tests (no @types/node in the project).
type Fs = { readFileSync(p: string): Uint8Array };
type NodeModule = { createRequire(url: string): { resolve(id: string): string } };
const nodeMod = async <T>(name: string): Promise<T> => (await import(/* @vite-ignore */ name)) as T;

let done = false;
export async function initWasm(): Promise<void> {
  if (done) return;
  const fs = await nodeMod<Fs>("node:fs");
  const { createRequire } = await nodeMod<NodeModule>("node:module");
  initSync({ module: fs.readFileSync(createRequire(import.meta.url).resolve("@ironcalc/wasm/wasm_bg.wasm")) });
  done = true;
}
