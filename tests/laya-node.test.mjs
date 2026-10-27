import assert from "node:assert/strict";
import test from "node:test";
import { loadLayaModel, prepareLayaModel } from "../dist/node.js";

const modelPath = process.env.SEMANTICA_MODEL_PATH;
const modelSourceUrl = process.env.SEMANTICA_MODEL_SOURCE_URL;
const downloadDirectory = process.env.SEMANTICA_MODEL_DOWNLOAD_DIR || "./.cache/test-laya-model";

test("Node downloads or reuses the prepared Laya model and classifies publication metadata", {
  skip: !modelPath && !modelSourceUrl,
}, async () => {
  let preparedPath = modelPath;
  if (!preparedPath && modelSourceUrl) {
    await prepareLayaModel(downloadDirectory, (label, percent) => {
      process.stdout.write(`\r[Laya ${percent}%] ${label}`);
    }, modelSourceUrl);
    process.stdout.write("\n");
    preparedPath = downloadDirectory;
  }
  const loadEvents = [];
  const laya = await loadLayaModel(preparedPath, (label, percent) => {
    loadEvents.push({ label, percent });
  });
  assert.ok(loadEvents.some(({ label }) => /ONNX Runtime con \d+ hilos/.test(label)));
  for (let index = 1; index < loadEvents.length; index += 1) {
    assert.ok(loadEvents[index].percent >= loadEvents[index - 1].percent, "El progreso de carga debe avanzar sin retroceder");
  }
  const result = await laya.classifyText(
    "Litoarte, S. de R L.\n\nFerrocarril de Cuernavaca 683\n\nCol. Ampliación Granada",
    () => undefined,
  );
  assert.deepEqual(result.blocks.map((block) => block.label), ["paragraph", "paragraph", "paragraph"]);
});
