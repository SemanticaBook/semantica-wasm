import assert from "node:assert/strict";
import test from "node:test";
import { loadLayaModel } from "../dist/node.js";

const modelPath = process.env.SEMANTICA_MODEL_PATH;

test("Node loads the shared Laya WASM core and preserves valid publication metadata", {
  skip: !modelPath && "Set SEMANTICA_MODEL_PATH to a prepared multilingual model directory (about 358 MB).",
}, async () => {
  const laya = await loadLayaModel(modelPath);
  const result = await laya.classifyText(
    "Litoarte, S. de R L.\n\nFerrocarril de Cuernavaca 683\n\nCol. Ampliación Granada",
    () => undefined,
  );
  assert.deepEqual(result.blocks.map((block) => block.label), ["paragraph", "paragraph", "paragraph"]);
});
