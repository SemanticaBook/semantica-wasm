import type { Buffer } from "node:buffer";

/** Return an input shape accepted by the active Tesseract.js runtime. */
export function getTesseractImageInput(canvas: HTMLCanvasElement): HTMLCanvasElement | Buffer {
  // tesseract.js' Node adapter reads bytes, while browsers accept the canvas.
  const nodeCanvas = canvas as HTMLCanvasElement & {
    toBuffer?: (mimeType?: string) => Buffer;
  };
  return typeof nodeCanvas.toBuffer === "function"
    ? nodeCanvas.toBuffer("image/png")
    : canvas;
}
