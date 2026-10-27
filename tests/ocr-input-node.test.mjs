import assert from "node:assert/strict";
import { createCanvas } from "@napi-rs/canvas";
import test from "node:test";
import { getTesseractImageInput } from "../dist/ocr-input.js";

test("serializes the native Node canvas to PNG bytes for Tesseract", () => {
  const canvas = createCanvas(64, 64);
  canvas.getContext("2d").fillRect(0, 0, 64, 64);
  const input = getTesseractImageInput(canvas);

  assert.ok(Buffer.isBuffer(input));
  assert.deepEqual([...input.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});

test("keeps browser canvas input unchanged", () => {
  const browserCanvas = { width: 64, height: 64 };
  assert.equal(getTesseractImageInput(browserCanvas), browserCanvas);
});
