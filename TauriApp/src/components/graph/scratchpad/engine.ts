/* Loads the IronCalc formula engine (MIT OR Apache-2.0, Rust → WebAssembly).
   Browser-only: the .wasm is a separate hashed asset fetched the first time the
   Scratchpad tab opens. Memoised; a failed load can be retried. */

import init from "@ironcalc/wasm";
import wasmUrl from "@ironcalc/wasm/wasm_bg.wasm?url";

let loading: Promise<void> | null = null;

export function loadEngine(): Promise<void> {
  if (!loading) {
    loading = init({ module_or_path: wasmUrl }).then(
      () => undefined,
      (e: unknown) => { loading = null; throw e; },
    );
  }
  return loading;
}
