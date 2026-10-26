import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCanvas, DOMMatrix, DOMPoint, ImageData, Path2D } from "@napi-rs/canvas";
import type { BookcliWasmClient } from "./client.js";
import { BookcliWasm, configureSemanticaWasmRuntime, type ModelLoadProgress } from "./index.js";
import { convertPdf, type ConversionProgress, type OutputFormat } from "./conversion.js";

type NodeConvertOptions = Parameters<typeof convertPdf>[4];
const modelPreparation = new Map<string, Promise<void>>();

async function ensureModelDirectory(modelDirectory: string, onProgress?: ModelLoadProgress) {
  const directory = resolve(modelDirectory);
  try {
    const manifest = JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8")) as {
      variants?: Record<string, { onnx?: string; data?: { parts?: string[] } }>;
    };
    const variant = manifest.variants?.q8e8 ?? manifest.variants?.qdq8;
    const requiredFiles = [
      "tokenizer.json",
      "tokenizer_config.json",
      "rl_agent_config.json",
      ...(variant?.onnx ? [variant.onnx] : []),
      ...(variant?.data?.parts ?? []),
    ];
    if (!variant || requiredFiles.length < 5) throw new Error("El manifiesto del modelo está incompleto.");
    await Promise.all(requiredFiles.map((file) => access(resolve(directory, file))));
    return false;
  } catch {
    // Missing or incomplete files are regenerated from the official checkpoint.
  }

  const existing = modelPreparation.get(directory);
  if (existing) {
    await existing;
    return true;
  }

  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const buildScript = resolve(packageRoot, "scripts/build-model.sh");
  onProgress?.("No encontré el modelo Laya; descargaré el checkpoint oficial y lo prepararé para ONNX…", 0);
  const preparing = new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("bash", [buildScript], {
      cwd: packageRoot,
      env: { ...process.env, WEB_MODEL_DIR: directory },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let pendingOutput = "";
    const reportLines = (chunk: Buffer) => {
      pendingOutput += chunk.toString();
      const lines = pendingOutput.split(/\r?\n/);
      pendingOutput = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) onProgress?.(line.trim(), 5);
      }
    };
    child.stdout.on("data", reportLines);
    child.stderr.on("data", reportLines);
    child.once("error", (error) => rejectPromise(new Error(
      `No pude iniciar la descarga/preparación automática de Laya. Se requiere Bash, Git y Python 3.11+: ${error.message}`,
      { cause: error },
    )));
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(
        `Falló la preparación automática de Laya (código ${code ?? "desconocido"}). Instala Git y Python 3.11+, revisa la conexión y ejecuta npm run model:download para ver el detalle.`,
      ));
    });
  });
  modelPreparation.set(directory, preparing);
  try {
    await preparing;
  } finally {
    modelPreparation.delete(directory);
  }
  return true;
}

/** Download and prepare the official Laya checkpoint without starting inference. */
export function prepareLayaModel(
  modelDirectory = "./models/laya-multilingual",
  onProgress?: ModelLoadProgress,
) {
  return ensureModelDirectory(modelDirectory, onProgress);
}

function installCanvasDocument() {
  const globals = globalThis as unknown as Record<string, unknown>;
  globals.Path2D ??= Path2D;
  globals.DOMMatrix ??= DOMMatrix;
  globals.DOMPoint ??= DOMPoint;
  globals.ImageData ??= ImageData;
  if (globalThis.document) return;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: (tag: string) => {
      if (tag !== "canvas") throw new Error(`Elemento DOM no compatible con Node: ${tag}`);
      return createCanvas(1, 1);
    } },
  });
}

export async function convertPdfPath(
  inputPath: string,
  format: OutputFormat,
  useOcr = false,
  onProgress: ConversionProgress = () => undefined,
  options: NodeConvertOptions = {},
) {
  installCanvasDocument();
  const bytes = await readFile(inputPath);
  const file = new File([bytes], basename(inputPath), { type: "application/pdf" });
  const coverPath = options.bookMetadata?.cover?.path;
  if (!coverPath) return convertPdf(file, format, useOcr, onProgress, options);
  const coverBytes = await readFile(resolve(coverPath));
  const extension = coverPath.split(".").pop()?.toLowerCase();
  if (extension !== "png" && extension !== "jpg" && extension !== "jpeg") {
    throw new Error("La portada local debe ser un archivo JPEG o PNG.");
  }
  const mimeType = extension === "png" ? "image/png" : "image/jpeg";
  const bookMetadata = {
    ...options.bookMetadata!,
    cover: { dataUrl: `data:${mimeType};base64,${coverBytes.toString("base64")}`, mimeType },
  };
  return convertPdf(file, format, useOcr, onProgress, { ...options, bookMetadata });
}

export async function convertPdfPaths(
  inputPaths: string[],
  format: OutputFormat,
  useOcr = false,
  onProgress: (fileIndex: number, totalFiles: number, value: number, label: string, fileName: string) => void = () => undefined,
  options: NodeConvertOptions = {},
) {
  const results = [];
  for (let index = 0; index < inputPaths.length; index += 1) {
    const inputPath = inputPaths[index];
    const result = await convertPdfPath(inputPath, format, useOcr, (value, label) => {
      onProgress(index + 1, inputPaths.length, value, label, basename(inputPath));
    }, options);
    results.push(result);
  }
  return results;
}

export async function loadLayaModel(
  modelDirectory = "./models/laya-multilingual",
  onProgress?: ModelLoadProgress,
) {
  const modelPrepared = await ensureModelDirectory(modelDirectory, onProgress);
  const require = createRequire(import.meta.url);
  const runtimeDirectory = dirname(require.resolve("onnxruntime-web"));
  const modelUrl = pathToFileURL(resolve(modelDirectory) + "/").href;
  configureSemanticaWasmRuntime({
    wasmPaths: {
      mjs: resolve(runtimeDirectory, "ort-wasm-simd-threaded.jsep.mjs"),
      wasm: resolve(runtimeDirectory, "ort-wasm-simd-threaded.jsep.wasm"),
    },
    readAsset: async (url) => new Uint8Array(await readFile(new URL(url))),
  });
  return BookcliWasm.load(modelUrl, (label, percent) => {
    onProgress?.(label, modelPrepared ? 35 + Math.round(percent * 0.65) : percent);
  });
}

export { convertPdf, convertPdfBatch, processPdfBatch } from "./conversion.js";
export type { OutputFormat, ConversionProgress, BatchConversionProgress, BatchConversionHandlers, RecoveredImage, SemanticaClassifier } from "./conversion.js";
export { searchBookMetadata } from "./metadata.js";
export type { BookMetadata, BookMetadataOptions, BookCoverCandidate, CoverAsset, CoverSelection, CoverSelectionRequest } from "./metadata.js";
export type { BookcliWasmClient };
export { BookcliWasm, BookcliWasm as SemanticaWasm, configureSemanticaWasmRuntime };
export type { ModelLoadProgress, ClassificationProgress, ClassificationEvent, ReviewHandler, ReviewQuestion, InferenceSettings, BookcliLabel, ClassifiedBlock } from "./index.js";
