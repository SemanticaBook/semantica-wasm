import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { availableParallelism, homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { createCanvas, DOMMatrix, DOMPoint, ImageData, Path2D } from "@napi-rs/canvas";
import type { BookcliWasmClient } from "./client.js";
import {
  BACKUP_LAYA_MODEL_BASE_URL,
  BookcliWasm,
  configureSemanticaWasmRuntime,
  DEFAULT_LAYA_MODEL_BASE_URL,
  type ModelLoadProgress,
} from "./index.js";
import { convertPdf, type ConversionProgress, type OutputFormat } from "./conversion.js";

type NodeConvertOptions = Parameters<typeof convertPdf>[4];
const modelPreparation = new Map<string, Promise<void>>();
const MODEL_ASSET_TIMEOUT_MS = 5 * 60 * 1000;

type ModelManifest = {
  chunk_bytes?: number;
  variants?: Record<string, {
    onnx: string;
    data: {
      name: string;
      size: number;
      sha256: string;
      parts: string[];
      partSha256?: string[];
    };
  }>;
};

function defaultModelCacheRoot() {
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  }
  return process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
}

/** Default writable model cache shared by Semantica projects for this user. */
export function getDefaultLayaModelDirectory() {
  return resolve(
    process.env.SEMANTICA_MODEL_DIR ||
      join(defaultModelCacheRoot(), "semantica", "models", "laya-multilingual"),
  );
}

function modelSources(modelBaseUrl?: string) {
  const configured = modelBaseUrl || process.env.SEMANTICA_LAYA_MODEL_BASE_URL;
  return [...new Set([
    ...(configured ? [configured] : []),
    DEFAULT_LAYA_MODEL_BASE_URL,
    BACKUP_LAYA_MODEL_BASE_URL,
  ].map((url) => url.endsWith("/") ? url : `${url}/`))];
}

function modelVariant(manifest: ModelManifest) {
  const variant = manifest.variants?.q8e8 ?? manifest.variants?.qdq8;
  if (!variant?.onnx || !variant.data?.name || !Number.isSafeInteger(variant.data.size) ||
    variant.data.size <= 0 || !Array.isArray(variant.data.parts) || !variant.data.parts.length ||
    !/^[a-f0-9]{64}$/i.test(variant.data.sha256)) {
    throw new Error("El manifiesto de Laya no contiene una variante ONNX completa y verificable.");
  }
  if (variant.data.partSha256 && variant.data.partSha256.length !== variant.data.parts.length) {
    throw new Error("El manifiesto de Laya tiene una lista de hashes por bloque incompleta.");
  }
  for (const name of ["tokenizer.json", "tokenizer_config.json", "rl_agent_config.json", variant.onnx, variant.data.name, ...variant.data.parts]) {
    safeModelPath("/model-root", name);
  }
  return variant;
}

function safeModelPath(directory: string, name: string) {
  if (!name || name.includes("\0") || isAbsolute(name) || name.includes("\\")) {
    throw new Error(`Ruta de asset de modelo no válida: ${name}`);
  }
  const path = resolve(directory, name);
  const fromRoot = relative(resolve(directory), path);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`El manifiesto intenta salir de la carpeta del modelo: ${name}`);
  }
  return path;
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readLocalManifest(directory: string) {
  try {
    return JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as ModelManifest;
  } catch {
    return undefined;
  }
}

async function hasValidModel(directory: string, manifest: ModelManifest) {
  try {
    const variant = modelVariant(manifest);
    for (const name of ["tokenizer.json", "tokenizer_config.json", "rl_agent_config.json", variant.onnx]) {
      if ((await stat(safeModelPath(directory, name))).size <= 0) return false;
    }

    let totalBytes = 0;
    const fullHash = createHash("sha256");
    for (let index = 0; index < variant.data.parts.length; index += 1) {
      const bytes = await readFile(safeModelPath(directory, variant.data.parts[index]));
      const expectedLength = manifest.chunk_bytes
        ? index === variant.data.parts.length - 1
          ? variant.data.size - index * manifest.chunk_bytes
          : manifest.chunk_bytes
        : undefined;
      if (expectedLength && bytes.byteLength !== expectedLength) return false;
      const expectedPartHash = variant.data.partSha256?.[index];
      if (expectedPartHash && sha256(bytes) !== expectedPartHash) return false;
      totalBytes += bytes.byteLength;
      fullHash.update(bytes);
    }
    return totalBytes === variant.data.size && fullHash.digest("hex") === variant.data.sha256;
  } catch {
    return false;
  }
}

async function fetchModelBytes(url: string) {
  if (url.startsWith("file:")) {
    return new Uint8Array(await readFile(new URL(url)));
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(MODEL_ASSET_TIMEOUT_MS) });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} al descargar ${url}`);
        if (![408, 425, 429, 500, 502, 503, 504].includes(response.status)) throw error;
        lastError = error;
      } else {
        return new Uint8Array(await response.arrayBuffer());
      }
    } catch (error) {
      lastError = error;
      if (error instanceof Error && /^HTTP (?:401|403|404)\b/.test(error.message)) throw error;
    }
    if (attempt < 2) await new Promise((resolvePromise) => setTimeout(resolvePromise, 500 * (2 ** attempt)));
  }
  throw new Error(`No se pudo descargar el recurso de Laya (${url}): ${lastError instanceof Error ? lastError.message : String(lastError)}`, { cause: lastError });
}

async function saveModelAsset(directory: string, baseUrl: string, name: string, expected?: { size?: number; sha256?: string }) {
  const destination = safeModelPath(directory, name);
  await mkdir(dirname(destination), { recursive: true });
  const bytes = await fetchModelBytes(new URL(name, baseUrl).toString());
  if (expected?.size !== undefined && bytes.byteLength !== expected.size) {
    throw new Error(`${name} tiene ${bytes.byteLength} bytes; el manifiesto esperaba ${expected.size}.`);
  }
  if (expected?.sha256 && sha256(bytes) !== expected.sha256) {
    throw new Error(`${name} no pasó la verificación SHA-256.`);
  }
  const temporaryPath = `${destination}.${process.pid}.${randomUUID()}.partial`;
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx" });
    await rename(temporaryPath, destination);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function downloadModelFromSource(directory: string, baseUrl: string, onProgress?: ModelLoadProgress) {
  const manifestBytes = await fetchModelBytes(new URL("manifest.json", baseUrl).toString());
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as ModelManifest;
  const variant = modelVariant(manifest);
  const localManifest = await readLocalManifest(directory);
  const localVariant = localManifest?.variants?.q8e8 ?? localManifest?.variants?.qdq8;
  const sameModel = localVariant?.data?.sha256 === variant.data.sha256;
  const simpleAssets = ["tokenizer.json", "tokenizer_config.json", "rl_agent_config.json", variant.onnx];
  const chunkNames = variant.data.parts;
  const totalAssets = simpleAssets.length + chunkNames.length;
  let completed = 0;

  for (const name of simpleAssets) {
    const path = safeModelPath(directory, name);
    const exists = sameModel && await stat(path).then((info) => info.size > 0).catch(() => false);
    if (!exists) await saveModelAsset(directory, baseUrl, name);
    completed += 1;
    onProgress?.(`Descargando Laya · archivo ${completed} de ${totalAssets} (${basename(name)})`, Math.round((completed / totalAssets) * 90));
  }

  for (let index = 0; index < chunkNames.length; index += 1) {
    const name = chunkNames[index];
    const path = safeModelPath(directory, name);
    const expectedLength = manifest.chunk_bytes
      ? index === chunkNames.length - 1
        ? variant.data.size - index * manifest.chunk_bytes
        : manifest.chunk_bytes
      : undefined;
    const expectedHash = variant.data.partSha256?.[index];
    const validExisting = await readFile(path).then((bytes) =>
      (!expectedLength || bytes.byteLength === expectedLength) && (!expectedHash || sha256(bytes) === expectedHash),
    ).catch(() => false);
    if (!validExisting) await saveModelAsset(directory, baseUrl, name, { size: expectedLength, sha256: expectedHash });
    completed += 1;
    onProgress?.(`Descargando y verificando Laya · bloque ${index + 1} de ${chunkNames.length}`, Math.round((completed / totalAssets) * 90));
  }

  const temporaryManifest = join(directory, `manifest.${process.pid}.${randomUUID()}.partial`);
  await writeFile(temporaryManifest, manifestBytes, { flag: "wx" });
  try {
    await rename(temporaryManifest, join(directory, "manifest.json"));
  } finally {
    await rm(temporaryManifest, { force: true }).catch(() => undefined);
  }
  if (!await hasValidModel(directory, manifest)) {
    throw new Error("El modelo descargado no coincide con los tamaños o hashes de su manifiesto.");
  }
}

async function ensureModelDirectory(modelDirectory: string, onProgress?: ModelLoadProgress, modelBaseUrl?: string) {
  const directory = resolve(modelDirectory);
  const localManifest = await readLocalManifest(directory);
  if (localManifest && await hasValidModel(directory, localManifest)) return false;

  const existing = modelPreparation.get(directory);
  if (existing) {
    await existing;
    return true;
  }

  onProgress?.("No encontré un modelo Laya válido; descargaré el modelo ONNX preparado…", 0);
  const preparing = (async () => {
    await mkdir(directory, { recursive: true });
    const failures: string[] = [];
    for (const baseUrl of modelSources(modelBaseUrl)) {
      try {
        onProgress?.(`Intentando obtener Laya desde ${new URL(baseUrl).host}…`, 0);
        await downloadModelFromSource(directory, baseUrl, onProgress);
        onProgress?.("Modelo Laya descargado y verificado", 90);
        return;
      } catch (error) {
        failures.push(`${baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
        onProgress?.("Esta fuente no está disponible; probando la siguiente…", 0);
      }
    }
    throw new Error(
      `No se pudo descargar un modelo Laya válido. Comprueba la conexión y que las fuentes permitan descargas públicas. ${failures.join(" | ")}`,
    );
  })();
  modelPreparation.set(directory, preparing);
  try {
    await preparing;
  } finally {
    modelPreparation.delete(directory);
  }
  return true;
}

/** Download and verify the ready-to-run Laya ONNX model without starting inference. */
export function prepareLayaModel(
  modelDirectory = getDefaultLayaModelDirectory(),
  onProgress?: ModelLoadProgress,
  modelBaseUrl?: string,
) {
  return ensureModelDirectory(modelDirectory, onProgress, modelBaseUrl);
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
  modelDirectory = getDefaultLayaModelDirectory(),
  onProgress?: ModelLoadProgress,
  modelBaseUrl?: string,
) {
  let lastProgress = 0;
  const reportProgress = (label: string, percent: number) => {
    lastProgress = Math.max(lastProgress, Math.max(0, Math.min(100, Math.round(percent))));
    onProgress?.(label, lastProgress);
  };
  const modelPrepared = await ensureModelDirectory(
    modelDirectory,
    (label, percent) => reportProgress(label, percent * (80 / 90)),
    modelBaseUrl,
  );
  const require = createRequire(import.meta.url);
  const runtimeDirectory = dirname(require.resolve("onnxruntime-web"));
  const modelUrl = pathToFileURL(resolve(modelDirectory) + "/").href;
  const configuredThreads = Number.parseInt(process.env.SEMANTICA_WASM_THREADS ?? "", 10);
  const wasmThreads = Number.isFinite(configuredThreads) && configuredThreads > 0
    ? configuredThreads
    : Math.max(1, Math.floor(availableParallelism() * 0.8));
  reportProgress(
    modelPrepared ? `Modelo verificado; iniciando ONNX Runtime con ${wasmThreads} hilos…` : `Modelo en caché; iniciando ONNX Runtime con ${wasmThreads} hilos…`,
    80,
  );
  configureSemanticaWasmRuntime({
    wasmPaths: {
      mjs: resolve(runtimeDirectory, "ort-wasm-simd-threaded.jsep.mjs"),
      wasm: resolve(runtimeDirectory, "ort-wasm-simd-threaded.jsep.wasm"),
    },
    wasmThreads,
    readAsset: async (url) => new Uint8Array(await readFile(new URL(url))),
  });
  const reportRuntimeProgress = (label: string, percent: number) => {
    let mappedPercent: number;
    if (label.startsWith("Modelo WASM")) {
      mappedPercent = 80 + Math.max(0, Math.min(85, percent)) * (9 / 85);
    } else if (label.startsWith("Verificando modelo")) {
      mappedPercent = 89 + Math.max(0, Math.min(5, percent - 85)) * 0.2;
    } else if (/iniciando onnx runtime/i.test(label)) {
      mappedPercent = 92;
    } else if (/reintentando con wasm/i.test(label)) {
      mappedPercent = 95;
    } else if (/laya multilingüe listo/i.test(label)) {
      mappedPercent = 100;
    } else {
      mappedPercent = Math.max(80, 80 + Math.max(0, Math.min(100, percent)) * 0.2);
    }
    reportProgress(label, mappedPercent);
  };
  return BookcliWasm.load(modelUrl, (label, percent) => {
    reportRuntimeProgress(label, percent);
  });
}

export type { ModelManifest };

export { convertPdf, convertPdfBatch, processPdfBatch } from "./conversion.js";
export type { OutputFormat, ConversionProgress, BatchConversionProgress, BatchConversionHandlers, RecoveredImage, SemanticaClassifier } from "./conversion.js";
export { searchBookMetadata } from "./metadata.js";
export type { BookMetadata, BookMetadataOptions, BookCoverCandidate, CoverAsset, CoverSelection, CoverSelectionRequest } from "./metadata.js";
export type { BookcliWasmClient };
export { BookcliWasm, BookcliWasm as SemanticaWasm, configureSemanticaWasmRuntime };
export type { ModelLoadProgress, ClassificationProgress, ClassificationEvent, ReviewHandler, ReviewQuestion, InferenceSettings, BookcliLabel, ClassifiedBlock } from "./index.js";
