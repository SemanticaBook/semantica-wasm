import wasmModuleUrl from "onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs?url";
import wasmBinaryUrl from "onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm?url";
import { configureSemanticaWasmRuntime } from "./index.js";

configureSemanticaWasmRuntime({
  wasmPaths: { mjs: wasmModuleUrl, wasm: wasmBinaryUrl },
});
