import type * as ortTypes from "onnxruntime-web";
import type { Tokenizer as HuggingFaceTokenizer } from "@huggingface/tokenizers";
import { buildSequence, type InternalQuestion } from "./sequence.js";
import { expandIndexBlocks, findIndexEntryIndexes, linkTableOfContents, type TocCandidateBlock } from "./toc.js";
export { expandIndexBlocks, findIndexEntryIndexes, linkTableOfContents } from "./toc.js";

export const BOOKCLI_LABELS = [
  {
    id: "title",
    name: "Título",
    description: "Título principal del documento o de una obra.",
  },
  {
    id: "heading",
    name: "Encabezado",
    description: "Encabezado de capítulo o sección principal.",
  },
  {
    id: "subheading",
    name: "Subencabezado",
    description: "Encabezado de subsección.",
  },
  { id: "paragraph", name: "Párrafo", description: "Párrafo normal de texto." },
  {
    id: "list_item",
    name: "Elemento de lista",
    description: "Elemento de una lista.",
  },
  {
    id: "caption",
    name: "Leyenda",
    description: "Leyenda de imagen, tabla o figura.",
  },
  {
    id: "noise",
    name: "Ruido OCR",
    description: "Solo texto ilegible o claramente corrupto por OCR; nunca prosa legible, diálogo, títulos, listas ni frases cortas válidas.",
  },
  {
    id: "other",
    name: "Otro",
    description: "Contenido válido que no encaja en las categorías anteriores.",
  },
] as const;

export type BookcliLabel = (typeof BOOKCLI_LABELS)[number]["id"];
export type ModelLoadProgress = (label: string, percent: number) => void;
export const DEFAULT_LAYA_MODEL_BASE_URL =
  "https://huggingface.co/SemanticaBook/semantica-laya-multilingual-onnx/resolve/main/";
export const BACKUP_LAYA_MODEL_BASE_URL =
  "https://raw.githubusercontent.com/SemanticaBook/laya-weights/main/";

class ModelSourceError extends Error {}
export type ClassificationProgress = (value: number, label: string) => void;
export type ClassificationEvent = {
  phase: "thinking" | "decided" | "review";
  index: number;
  total: number;
  text: string;
  label?: BookcliLabel;
};
export type ReviewQuestion = {
  block: string;
  suggested_label: BookcliLabel;
  confidence: number;
  previous_context: string[];
  next_context: string[];
  labels: { id: string; description: string }[];
  style_rules: string | null;
  expiresAt: number;
};
export type ReviewHandler = (question: ReviewQuestion) => Promise<BookcliLabel>;
export type InferenceSettings = {
  instructions: string;
  minContextLevel: number;
  maxContextLevel: number;
  autoAcceptThreshold: number;
  keepNoise: boolean;
};
export type ClassifiedBlock = TocCandidateBlock;

type Manifest = {
  chunk_bytes?: number;
  variants: Record<
    string,
    {
      onnx: string;
      data: { name: string; size: number; sha256: string; parts: string[]; partSha256?: string[] };
    }
  >;
};
type TokenizerJson = {
  added_tokens?: { id: number; content: string }[];
  model?: { vocab?: Record<string, number> };
};
type TokenizerConfig = {
  cls_token?: string | { content?: string };
  sep_token?: string | { content?: string };
  mask_token?: string | { content?: string };
  pad_token?: string | { content?: string };
};
type ModelConfig = {
  max_len?: number;
  head_max_len?: number;
  temperature?: number[];
  temperature_by_options?: Record<string, number>;
};

export type SemanticaWasmRuntime = {
  wasmPaths: { mjs: string; wasm: string };
  readAsset?: (url: string) => Promise<Uint8Array>;
};

let runtimeConfig: SemanticaWasmRuntime | null = null;
let readAsset: (url: string) => Promise<Uint8Array> = async (url) => {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`No se pudo cargar ${url} (${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
};

export function configureSemanticaWasmRuntime(config: SemanticaWasmRuntime) {
  runtimeConfig = config;
  if (config.readAsset) readAsset = config.readAsset;
}

const LABEL_CRITERIA = Object.fromEntries(
  BOOKCLI_LABELS.map(({ id, description }) => [id, description]),
);
const CLASSIFICATION_INSTRUCTIONS = [
  "Clasifica SOLO el bloque entre [BLOQUE A CLASIFICAR] y su cierre.",
  "Usa el contexto anterior y posterior como referencia, no lo clasifiques.",
  "No corrijas, resumas ni inventes contenido. Clasifica el texto tal como aparece.",
  "Usa noise SOLO cuando el bloque sea ilegible o esté claramente corrupto por OCR. Si el texto forma palabras y una frase legible en el idioma del libro, NO es ruido OCR aunque sea corto, tenga guiones de diálogo, signos, una línea o algún error menor: clasifícalo según su función, normalmente paragraph.",
  "Los nombres de autores, editoriales, imprentas, direcciones, códigos postales y datos de edición son contenido válido; clasifícalos como paragraph, no como heading ni noise.",
  "Distingue title (título de obra), heading (capítulo/sección), subheading (subsección), paragraph (prosa), list_item (lista), caption (leyenda), noise (ruido OCR) y other (contenido válido restante).",
  "Los números de página suelen ser noise. Un índice es list_item, no heading.",
].join(" ");
const COMMON_SPANISH_WORDS = new Set((
  "que los las del una uno unos unas como para por con sin entre desde hasta " +
  "este esta estos estas eso ese ella ellos ellas nosotros ustedes somos son " +
  "viven aqui aquí donde cuando mientras porque pues pero aunque tambien " +
  "también muy mas más menos todo toda todos todas quien quienes cual cuales " +
  "familia puerta caverna cerraba espaldas aminoacidos aminoácidos habian habían " +
  "entrado reino cuerpo humano repente enorme saliva elevó empezo empezó " +
  "arrastrar tunel túnel largo estrecho bajaba penetrando entrada letrero decía " +
  "esofago esófago caian caían daban gracias estuvieran envueltos contrario " +
  "golpeado golpeaban atorado paredes aquel oscuro tubo finalmente dejaron caer " +
  "triptofanito pudo abrir ojos cuenta encontraban amigos sitio importantes " +
  "pobladores capítulo capitulo viaje principia principio viven ustedes aqui " +
  "vivo somos dijo preguntó respondio respondió estaban estaba habia había " +
  "será era eran puede pueden hacer hizo observó camino llegaron dijo " +
  "texto libro lectura historia personas lugar tiempo parte manera mientras " +
  "niños niñas mundo vida hombre mujer casa tierra palabra palabras " +
  "proteina proteína vio " +
  "su sus le les lo al el la de en y o a se me mi tu tú ya no sí si " +
  "hola buenos dias días gracias señor señora pregunta respuesta"
).split(/\s+/));

function isClearlyReadableText(text: string): boolean {
  const clean = text.normalize("NFC").trim();
  if (clean.length < 4 || /[�□]{2,}/u.test(clean)) return false;
  const letters = clean.match(/\p{L}/gu) ?? [];
  const visible = clean.replace(/\s/gu, "");
  if (letters.length < 4 || !visible.length || letters.length / visible.length < 0.55) return false;

  const latinLetters = letters.filter((letter) => /\p{Script=Latin}/u.test(letter));
  if (latinLetters.length / letters.length < 0.75) {
    // For scripts without Latin vowel patterns, coherent letter runs are a
    // stronger signal than applying Spanish-specific heuristics.
    return letters.length >= 8 && !/(.)\1{4,}/u.test(clean);
  }

  const words = (clean.match(/[\p{Script=Latin}\p{M}]+/gu) ?? [])
    .map((word) => word.toLocaleLowerCase("es"));
  if (words.length && words.every((word) => COMMON_SPANISH_WORDS.has(word))) return true;
  const vowelCount = latinLetters.filter((letter) => /[aeiouáéíóúü]/iu.test(letter)).length;
  const meaningful = words.filter((word) => word.length >= 3);
  const longer = meaningful.filter((word) => word.length >= 4);
  const familiarCount = meaningful.filter((word) => COMMON_SPANISH_WORDS.has(word)).length;
  const wordlikeLong = longer.filter((word) =>
    /[aeiouáéíóúü]/iu.test(word) &&
    !/[^aeiouáéíóúü]{4,}/iu.test(word) &&
    !/(.)\1{3,}/iu.test(word),
  ).length;
  const supportedRatio = meaningful.length ? familiarCount / meaningful.length : 0;
  const longWordRatio = meaningful.length ? wordlikeLong / meaningful.length : 0;
  return vowelCount / latinLetters.length >= 0.22 &&
    (words.some((word) => word.length <= 2 && COMMON_SPANISH_WORDS.has(word)) || meaningful.length >= 2) &&
    ((familiarCount >= 2 && supportedRatio >= 0.28) ||
      (wordlikeLong >= 3 && longWordRatio >= 0.7));
}

function isPublicationMetadata(text: string): boolean {
  const clean = text.trim();
  return (
    /\bS\.?\s*de\s*R\.?\s*L\.?\b/i.test(clean) ||
    /\bS\.?\s*A\.?\s*(?:de\s*C\.?\s*V\.?)?\b/i.test(clean) ||
    /\b(?:ISBN|©|impreso en|hecho en|editorial|imprenta|litoarte)\b/i.test(clean) ||
    /\b(?:calle|av(?:enida)?|ferrocarril|carretera|boulevard|blvd\.?|paseo|privada)\b.*\b\d{1,5}\b/i.test(clean) ||
    /^(?:col\.?|colonia|c\.?\s*p\.?|c[oó]digo postal)\s+/i.test(clean)
  );
}

function serializeState(
  block: string,
  previous: string[],
  next: string[],
  decisions: { label: BookcliLabel; text: string }[],
): string {
  const parts: string[] = [];
  const recentDecisions = decisions.slice(-5);
  if (recentDecisions.length) {
    parts.push(
      "[DECISIONES PREVIAS DEL USUARIO]\n" +
        recentDecisions
          .map((item) => `- [${item.label}] ${item.text.slice(0, 150)}`)
          .join("\n"),
    );
  }
  const priorContext = previous.slice(-5);
  priorContext.forEach((text, index) =>
    parts.push(`[CONTEXTO ANTERIOR ${index - priorContext.length}]\n${text}`),
  );
  parts.push(`[BLOQUE A CLASIFICAR]\n${block}`);
  next
    .slice(0, 5)
    .forEach((text, index) =>
      parts.push(`[CONTEXTO POSTERIOR ${index + 1}]\n${text}`),
    );
  return parts.join("\n\n");
}

function temperatureBucket(optionCount: number): string {
  const bucket =
    optionCount <= 2
      ? "2"
      : optionCount <= 5
        ? "3-5"
        : optionCount <= 10
          ? "6-10"
          : "11+";
  return `choice:${bucket}`;
}

function specialTokenId(
  tokenizer: TokenizerJson,
  config: TokenizerConfig,
  key: "cls_token" | "sep_token" | "mask_token" | "pad_token",
): number {
  const setting = config[key];
  const content = typeof setting === "string" ? setting : setting?.content;
  if (!content) throw new Error(`La configuración Laya no define ${key}.`);
  const added = tokenizer.added_tokens?.find(
    (item) => item.content === content,
  );
  const id = added?.id ?? tokenizer.model?.vocab?.[content];
  if (id == null)
    throw new Error(`No se encontró el token especial ${content}.`);
  return id;
}

function specialTokenText(
  config: TokenizerConfig,
  key: "cls_token" | "sep_token" | "mask_token" | "pad_token",
): string {
  const setting = config[key];
  const content = typeof setting === "string" ? setting : setting?.content;
  if (!content) throw new Error(`La configuración Laya no define ${key}.`);
  return content;
}

function probabilities(
  logits: ArrayLike<number>,
  count: number,
  temperature: number,
) {
  const scale = Number.isFinite(temperature)
    ? Math.max(0.5, Math.min(5, temperature))
    : 1;
  const values = Array.from(
    { length: count },
    (_, index) => logits[index] / scale,
  );
  const max = Math.max(...values);
  const exponentials = values.map((value) => Math.exp(value - max));
  const total = exponentials.reduce((sum, value) => sum + value, 0);
  const result = exponentials.map((value) => value / total);
  const entropy = -result.reduce(
    (sum, value) => sum + value * Math.log(Math.max(value, 1e-12)),
    0,
  );
  return {
    values: result,
    answerConfidence: Math.max(...result),
    confidence:
      count < 2 ? 1 : Math.max(0, Math.min(1, 1 - entropy / Math.log(count))),
  };
}

function evaluateStyleRule(text: string, firstBlock: boolean) {
  const clean = text.trim();
  const length = clean.length;
  const words = clean.split(/\s+/).filter(Boolean).length;
  const letters = clean.match(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]/g) ?? [];
  const uppercaseRatio = letters.length
    ? letters.filter((letter) => letter === letter.toUpperCase()).length /
      letters.length
    : 0;
  const endsSentence = /[.!?…]["»”']?$/.test(clean);
  const rules: { label: BookcliLabel; weight: number; detail: string }[] = [];
  const add = (label: BookcliLabel, weight: number, detail: string) =>
    rules.push({ label, weight, detail });

  if (/^[\d\s]{1,8}$/.test(clean) || /^[IVXLCDM]{1,7}$/i.test(clean)) {
    return {
      label: "noise" as BookcliLabel,
      weight: 0.95,
      detail: "número de página",
    };
  }
  if (/^(cap[ií]tulo|parte|libro|unidad)\b/i.test(clean)) {
    add("heading", length < 120 ? 0.9 : 0.6, "prefijo de capítulo o sección");
  } else if (
    /^(secci[oó]n|anexo|ap[eé]ndice|índice|contenido|pr[oó]logo|ep[ií]logo|ep[oó]grafe|agradecimientos|bibliograf[ií]a|introducci[oó]n|conclusi[oó]n|notas|del\s+autor|acerca\s+de)\b/i.test(
      clean,
    )
  ) {
    add(
      "heading",
      length < 20 ? 0.86 : length < 100 ? 0.72 : 0.6,
      "nombre de sección",
    );
  }
  if (letters.length >= 3 && uppercaseRatio === 1 && length < 90) {
    add("heading", 0.88, "texto completamente en mayúsculas");
  }
  if (
    length < 70 &&
    words <= 6 &&
    !endsSentence &&
    !clean.endsWith(",") &&
    !clean.endsWith(";") &&
    !clean.includes(",") &&
    /^[A-ZÁÉÍÓÚÜÑ\d]/.test(clean)
  ) {
    add("heading", 0.6, "bloque corto sin puntuación final");
  }
  if (
    /^(fig\.?|figura|l[áa]mina|tabla|ilustraci[oó]n|grabado|l[oó]mina|dibuj[oa])\s*/i.test(
      clean,
    ) &&
    length < 120
  ) {
    add("caption", 0.8, "leyenda de imagen o tabla");
  }
  const numbered =
    /^\s*(\d{1,2}(?:[.\-]\d{1,2})*|[IVXLCDM]{1,6})[.)\-]\s+\S/i.test(clean);
  if (
    /^\s*([-•*–—▪·]|\(\d{1,2}\)|\d{1,2}[.)])\s+\S/.test(clean) &&
    !(numbered && length < 70)
  ) {
    add("list_item", 0.86, "viñeta o marca de lista");
  }
  if (/(?:\.\s*){3,}/.test(clean)) {
    add("list_item", 0.86, "entrada de índice");
  } else if (words >= 35 || length >= 220) {
    add("paragraph", 0.7, "texto extenso");
  } else if (endsSentence && words >= 12) {
    add("paragraph", 0.6, "frase completa");
  }
  if (
    firstBlock &&
    letters.length >= 3 &&
    uppercaseRatio === 1 &&
    length < 90
  ) {
    add("title", 0.8, "primer bloque en mayúsculas");
  }
  return rules.reduce<{
    label: BookcliLabel;
    weight: number;
    detail: string;
  } | null>(
    (best, current) =>
      best === null || current.weight > best.weight ? current : best,
    null,
  );
}

async function sha256(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function fetchJson<T>(url: string): Promise<T> {
  try {
    const bytes = await readAsset(url);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch (cause) {
    throw new ModelSourceError(`No se pudo cargar el recurso del modelo ${url}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

function resolveExecutionProviders(): string[] {
  const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent) ||
    Boolean((navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile);
  const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  // Mobile WebGPU can reserve a second copy of this large model in GPU memory.
  // Prefer the smaller single-threaded WASM footprint on phones and tablets.
  if (mobile || (deviceMemory !== undefined && deviceMemory <= 4)) return ["wasm"];
  const webgpuAvailable =
    typeof navigator !== "undefined" &&
    typeof (navigator as Navigator & { gpu?: unknown }).gpu !== "undefined";
  if (!webgpuAvailable) return ["wasm"];
  // Prefer the device GPU (WebGPU) and keep the WebAssembly CPU backend as fallback.
  return ["webgpu", "wasm"];
}

function resolveWasmThreadCount(): number {
  if (typeof navigator === "undefined") return 1;
  const userAgent = navigator.userAgent;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent) ||
    Boolean((navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile);
  const deviceMemory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (mobile || (deviceMemory !== undefined && deviceMemory <= 4) || !globalThis.crossOriginIsolated) return 1;
  const logicalCores = Math.max(1, navigator.hardwareConcurrency || 2);
  // numThreads includes the main inference thread. Leave at least 20% of the
  // reported logical processors available to the browser and other apps.
  return Math.max(1, Math.floor(logicalCores * 0.8));
}

export class BookcliWasm {
  private constructor(
    private readonly session: ortTypes.InferenceSession,
    private readonly tokenizer: HuggingFaceTokenizer,
    private readonly config: ModelConfig,
    private readonly runtime: typeof import("onnxruntime-web"),
    private readonly special: {
      cls: number;
      sep: number;
      mask: number;
      pad: number;
    },
    private readonly maskToken: string,
  ) {}

  static async load(
    baseUrl = DEFAULT_LAYA_MODEL_BASE_URL,
    onProgress: ModelLoadProgress = () => undefined,
  ): Promise<BookcliWasm> {
    const sources = [...new Set([baseUrl, BACKUP_LAYA_MODEL_BASE_URL])];
    const failures: string[] = [];
    let lastError: unknown;
    for (let index = 0; index < sources.length; index += 1) {
      try {
        return await this.loadFromBaseUrl(sources[index], onProgress);
      } catch (error) {
        lastError = error;
        if (!(error instanceof ModelSourceError) || index === sources.length - 1) throw error;
        failures.push(`${sources[index]}: ${error.message}`);
        onProgress("Fuente principal no disponible; intentando el respaldo de Semantica…", 0);
      }
    }
    throw new Error(`No se pudo cargar Laya desde sus fuentes. ${failures.join(" | ")}`, { cause: lastError });
  }

  private static async loadFromBaseUrl(
    baseUrl: string,
    onProgress: ModelLoadProgress,
  ): Promise<BookcliWasm> {
    const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    onProgress("Leyendo manifiesto del modelo…", 0);
    const [{ Tokenizer }, ort] = await Promise.all([
      import("@huggingface/tokenizers"),
      import("onnxruntime-web"),
    ]);
    const manifest = await fetchJson<Manifest>(`${base}manifest.json`);
    const variant = manifest.variants.q8e8 ?? manifest.variants.qdq8;
    if (!variant)
      throw new ModelSourceError(
        "El modelo no incluye una variante ONNX compatible con WASM.",
      );
    const [tokenizerJson, tokenizerConfig, config] = await Promise.all([
      fetchJson<TokenizerJson>(`${base}tokenizer.json`),
      fetchJson<TokenizerConfig>(`${base}tokenizer_config.json`),
      fetchJson<ModelConfig>(`${base}rl_agent_config.json`),
    ]);
    const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
    const special = {
      cls: specialTokenId(tokenizerJson, tokenizerConfig, "cls_token"),
      sep: specialTokenId(tokenizerJson, tokenizerConfig, "sep_token"),
      mask: specialTokenId(tokenizerJson, tokenizerConfig, "mask_token"),
      pad: specialTokenId(tokenizerJson, tokenizerConfig, "pad_token"),
    };
    const maskToken = specialTokenText(tokenizerConfig, "mask_token");
    let cache: Cache | null = null;
    if ("caches" in globalThis) {
      try {
        cache = await caches.open("bookcli-wasm-model-v1");
      } catch {
        onProgress("Caché del navegador no disponible; continuaré sin guardado local", 0);
      }
    }
    let weights: Uint8Array;
    try {
      weights = new Uint8Array(variant.data.size);
    } catch (cause) {
      throw new Error(
        `El dispositivo no tiene memoria suficiente para preparar el modelo (${variant.data.size} bytes). Cierra otras pestañas y vuelve a intentarlo.`,
        { cause },
      );
    }
    let downloaded = 0;
    for (let index = 0; index < variant.data.parts.length; index += 1) {
      const name = variant.data.parts[index];
      const url = `${base}${name}`;
      const cacheKey = `${url}?sha256=${variant.data.sha256}`;
      let cached: Response | undefined;
      if (cache) {
        try {
          cached = await cache.match(cacheKey);
        } catch {
          cache = null;
        }
      }
      let bytes: Uint8Array;
      let fromCache = Boolean(cached);
      if (cached) {
        try {
          bytes = new Uint8Array(await cached.arrayBuffer());
        } catch (cause) {
          if (cache) await cache.delete(cacheKey).catch(() => undefined);
          throw new Error(`No se pudo leer el bloque ${name} desde Cache Storage; se eliminó para descargarlo de nuevo.`, { cause });
        }
      } else {
        try {
          bytes = await readAsset(url);
        } catch (cause) {
          throw new ModelSourceError(`Falló la descarga de ${name}. Revisa la conexión y que el hosting permita servir los archivos del modelo.`, { cause });
        }
        fromCache = false;
      }
      const expectedLength = index === variant.data.parts.length - 1 && manifest.chunk_bytes
        ? variant.data.size - index * manifest.chunk_bytes
        : manifest.chunk_bytes;
      if (expectedLength && bytes.byteLength !== expectedLength) {
        if (fromCache && cache) await cache.delete(cacheKey).catch(() => undefined);
        throw new ModelSourceError(`El bloque ${name} tiene ${bytes.byteLength} bytes; se esperaban ${expectedLength}. Limpia la caché del sitio y vuelve a intentar.`);
      }
      const expectedPartHash = variant.data.partSha256?.[index];
      if (expectedPartHash) {
        let partHash: string;
        try {
          partHash = await sha256(bytes);
        } catch (cause) {
          throw new Error(`Android no pudo verificar el bloque ${index + 1}/${variant.data.parts.length} por memoria. Cada bloque ocupa ${(bytes.byteLength / (1024 * 1024)).toFixed(1)} MiB y los pesos completos ${(variant.data.size / (1024 * 1024)).toFixed(1)} MiB.`, { cause });
        }
        if (partHash !== expectedPartHash) {
          if (cache) await cache.delete(cacheKey).catch(() => undefined);
          throw new ModelSourceError(`El bloque ${name} no pasó la verificación SHA-256. Se eliminó de la caché; vuelve a cargarlo con una conexión estable.`);
        }
        onProgress(
          `Verificando modelo · bloque ${index + 1} de ${variant.data.parts.length}`,
          85 + Math.round(((index + 1) / variant.data.parts.length) * 5),
        );
      }
      if (!fromCache && cache) {
        try {
          await cache.put(cacheKey, new Response(bytes));
        } catch {
          // Cache quota/private mode must not prevent an in-memory session.
          cache = null;
          onProgress("Caché llena o bloqueada; continuaré en memoria", 85);
        }
      }
      weights.set(bytes, downloaded);
      downloaded += bytes.byteLength;
      onProgress(
        `Modelo WASM · bloque ${index + 1} de ${variant.data.parts.length}`,
        Math.round((downloaded / variant.data.size) * 85),
      );
    }
    if (downloaded !== variant.data.size) {
      throw new ModelSourceError(
        "El tamaño descargado del modelo no coincide con el manifiesto.",
      );
    }
    const allPartsVerified = variant.data.partSha256?.length === variant.data.parts.length;
    if (allPartsVerified) {
      onProgress("Todos los bloques del modelo pasaron SHA-256", 90);
    } else {
      let checksum: string;
      try {
        checksum = await sha256(weights);
      } catch (cause) {
        throw new Error(
          `El navegador no pudo verificar de una sola vez los ${(variant.data.size / (1024 * 1024)).toFixed(1)} MiB del modelo por memoria. Publica un manifiesto con SHA-256 por bloque para Android.`,
          { cause },
        );
      }
      if (checksum !== variant.data.sha256) {
        if (cache)
          await Promise.all(
            variant.data.parts.map((name) =>
              cache.delete(`${base}${name}?sha256=${variant.data.sha256}`),
            ),
          );
        throw new ModelSourceError("La verificación SHA-256 del modelo falló. Vuelve a cargarlo.");
      }
    }
    if (!runtimeConfig) throw new Error("Configura el runtime WASM antes de cargar Laya.");
    ort.env.wasm.wasmPaths = runtimeConfig.wasmPaths as unknown as string;
    const wasmThreadCount = resolveWasmThreadCount();
    ort.env.wasm.numThreads = wasmThreadCount;
    ort.env.webgpu.powerPreference = "high-performance";
    const executionProviders = resolveExecutionProviders();
    onProgress(
      executionProviders.includes("webgpu")
        ? "Iniciando ONNX Runtime · WebGPU preferida, WASM de respaldo…"
        : `Iniciando ONNX Runtime · CPU WASM con ${wasmThreadCount} hilo${wasmThreadCount === 1 ? "" : "s"}…`,
      90,
    );
    let modelBytes: Uint8Array;
    try {
      modelBytes = await readAsset(`${base}${variant.onnx}`);
    } catch (cause) {
      throw new ModelSourceError(`No se pudo descargar ${variant.onnx} desde ${base}.`, { cause });
    }
    const createSession = (providers: string[]) => ort.InferenceSession.create(modelBytes, {
      executionProviders: providers,
      graphOptimizationLevel: "all",
      externalData: [{ path: variant.data.name, data: weights }],
    });
    let session: ortTypes.InferenceSession;
    try {
      session = await createSession(executionProviders);
    } catch (cause) {
      if (executionProviders.includes("webgpu")) {
        const firstError = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
        onProgress("WebGPU no inició; reintentando con WASM…", 92);
        try {
          session = await createSession(["wasm"]);
        } catch (fallbackCause) {
          const fallbackError = fallbackCause instanceof Error
            ? `${fallbackCause.name}: ${fallbackCause.message}`
            : String(fallbackCause);
          throw new Error(`Falló WebGPU (${firstError}) y también WASM (${fallbackError}).`, { cause: fallbackCause });
        }
      } else {
        const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
        throw new Error(
          `ONNX Runtime no pudo iniciar Laya (${executionProviders.join(" → ")}): ${detail}. Los pesos ocupan ${(variant.data.size / (1024 * 1024)).toFixed(1)} MiB y se requiere memoria adicional para la copia WASM y la sesión; puede faltar memoria disponible.`,
          { cause },
        );
      }
    }
    onProgress("Laya multilingüe listo en este dispositivo", 100);
    return new BookcliWasm(session, tokenizer, config, ort, special, maskToken);
  }

  async classifyBlock(
    block: string,
    previous: string[] = [],
    next: string[] = [],
    decisions: { label: BookcliLabel; text: string }[] = [],
    instructions = CLASSIFICATION_INSTRUCTIONS,
  ): Promise<{
    label: BookcliLabel;
    confidence: number;
    entropyConfidence: number;
  }> {
    const maxLength = this.config.max_len ?? 1024;
    const headMaxLength = this.config.head_max_len ?? 256;
    const question: InternalQuestion = {
      t: "choice",
      ins: instructions,
      crit: LABEL_CRITERIA,
    };
    const { ids, markers } = buildSequence(
      this.tokenizer,
      this.special,
      this.maskToken,
      serializeState(block, previous, next, decisions),
      question,
      maxLength,
      headMaxLength,
    );
    const inputIds = BigInt64Array.from(ids, BigInt);
    const attention = new BigInt64Array(ids.length).fill(1n);
    const positions = BigInt64Array.from(markers, BigInt);
    const mask = new Uint8Array(markers.length).fill(1);
    const output = await this.session.run({
      input_ids: new this.runtime.Tensor("int64", inputIds, [1, ids.length]),
      attention_mask: new this.runtime.Tensor("int64", attention, [
        1,
        ids.length,
      ]),
      marker_pos: new this.runtime.Tensor("int64", positions, [
        1,
        positions.length,
      ]),
      marker_mask: new this.runtime.Tensor("bool", mask, [1, mask.length]),
      qtype: new this.runtime.Tensor("int64", BigInt64Array.of(0n), [1]),
    });
    const logits = output.logits?.data;
    if (!logits) throw new Error("El modelo Laya no devolvió logits.");
    const optionCount = BOOKCLI_LABELS.length;
    const bucket = temperatureBucket(optionCount);
    const temperature =
      this.config.temperature_by_options?.[bucket] ??
      this.config.temperature?.[0] ??
      1;
    const scored = probabilities(
      logits as ArrayLike<number>,
      optionCount,
      temperature,
    );
    const best = scored.values.indexOf(Math.max(...scored.values));
    return {
      label: BOOKCLI_LABELS[best].id,
      confidence: scored.answerConfidence,
      entropyConfidence: scored.confidence,
    };
  }

  async classifyText(
    text: string,
    onProgress: ClassificationProgress,
    onReview?: ReviewHandler,
    autoAcceptThreshold = 0.85,
    keepNoise = true,
    onBlock?: (event: ClassificationEvent) => void,
    settings?: Partial<InferenceSettings>,
  ): Promise<{
    markdown: string;
    blocks: ClassifiedBlock[];
  }> {
    const sourceBlocks = text
      .split(/\n\s*\n+/)
      .map((part) => part.trim())
      .filter(Boolean);
    const expandedSources = sourceBlocks.flatMap((part, sourceIndex) => {
      const expanded = expandIndexBlocks(part);
      return expanded.map((text, index) => ({
        text,
        sourceIndex: index === expanded.length - 1 ? sourceIndex : undefined,
      }));
    });
    const expandedBlocks = expandedSources.map(({ text: block }) => block);
    const tocEntryIndexes = findIndexEntryIndexes(expandedBlocks);
    const results: ClassifiedBlock[] =
      [];
    const decisions: { label: BookcliLabel; text: string }[] = [];
    const minContextLevel = Math.max(0, Math.min(5, Math.floor(settings?.minContextLevel ?? 3)));
    const maxContextLevel = Math.max(minContextLevel, Math.min(5, Math.floor(settings?.maxContextLevel ?? 5)));
    const instructions = settings?.instructions?.trim() || CLASSIFICATION_INSTRUCTIONS;
    autoAcceptThreshold = settings?.autoAcceptThreshold ?? autoAcceptThreshold;
    keepNoise = settings?.keepNoise ?? keepNoise;
    for (let index = 0; index < expandedBlocks.length; index += 1) {
      const block = expandedBlocks[index];
      const total = expandedBlocks.length;
      onBlock?.({ phase: "thinking", index, total, text: block });
      const publicationMetadata = isPublicationMetadata(block);
      const isTocEntry = tocEntryIndexes.has(index);
      const prior = publicationMetadata || isTocEntry ? null : evaluateStyleRule(block, index === 0);
      const previous = expandedBlocks.slice(Math.max(0, index - 5), index);
      const next = expandedBlocks.slice(index + 1, index + 6);
      let prediction = {
        label: "other" as BookcliLabel,
        confidence: 0,
        entropyConfidence: 0,
      };
      if (isTocEntry) {
        prediction = { label: "list_item", confidence: 0.98, entropyConfidence: 0.98 };
      } else if (publicationMetadata) {
        prediction = {
          label: "paragraph",
          confidence: 0.96,
          entropyConfidence: 0.96,
        };
      } else if (prior && prior.weight >= 0.85) {
        prediction = {
          label: prior.label,
          confidence: prior.weight,
          entropyConfidence: prior.weight,
        };
      } else {
        for (let radius = minContextLevel; radius <= maxContextLevel; radius += 1) {
          onProgress(
            Math.round(((index + (radius - 1) / 5) / total) * 90),
            `Laya WASM · bloque ${index + 1} de ${total} · contexto ${radius}/5`,
          );
          prediction = await this.classifyBlock(
            block,
            previous.slice(-radius),
            next.slice(0, radius),
            decisions,
            instructions,
          );
          if (prediction.confidence >= autoAcceptThreshold) break;
        }
      }
      let styleRules: string | null = null;
      if (prior && prediction.label !== prior.label) {
        const strong = prior.weight >= 0.85;
        const uncertain =
          prediction.confidence < 0.65 ||
          prediction.label === "noise" ||
          prediction.label === "other";
        if (strong || (prior.weight >= 0.55 && uncertain)) {
          prediction = {
            ...prediction,
            label: prior.label,
            confidence: Math.max(prediction.confidence, prior.weight),
          };
          styleRules = `${prior.detail} (${Math.round(prior.weight * 100)}%)`;
        }
      }
      if (prediction.label === "noise" && isClearlyReadableText(block)) {
        prediction = {
          label: "paragraph",
          confidence: Math.max(0.86, prediction.confidence),
          entropyConfidence: prediction.entropyConfidence,
        };
        styleRules = "texto legible: no se permite clasificarlo como ruido OCR";
      }
      if (prediction.confidence < autoAcceptThreshold && onReview) {
        onBlock?.({
          phase: "review",
          index,
          total,
          text: block,
          label: prediction.label,
        });
        prediction.label = await onReview({
          block,
          suggested_label: prediction.label,
          confidence: prediction.confidence,
          previous_context: previous.slice(-maxContextLevel),
          next_context: next.slice(0, maxContextLevel),
          labels: BOOKCLI_LABELS.map(({ id, description }) => ({
            id,
            description,
          })),
          style_rules: styleRules,
          expiresAt: Date.now() + 30_000,
        });
        decisions.push({ label: prediction.label, text: block });
      }
      onBlock?.({
        phase: "decided",
        index,
          total,
        text: block,
        label: prediction.label,
      });
      results.push({ text: block, sourceIndex: expandedSources[index].sourceIndex, ...prediction });
      onProgress(
        Math.round(((index + 1) / total) * 90),
        `Laya WASM · bloque ${index + 1} de ${total}`,
      );
    }
    const linkedResults = linkTableOfContents(results);
    const markdown = linkedResults
      .map(({ text: block, label, anchorId, targetId, isTocEntry }) => {
        const safe = block.trim();
        if (isTocEntry) return `- ${targetId ? `[${safe}](#${targetId})` : safe}`;
        if (label === "title") return `${anchorId ? `<a id="${anchorId}"></a>\n` : ""}# ${safe}`;
        if (label === "heading") return `${anchorId ? `<a id="${anchorId}"></a>\n` : ""}## ${safe}`;
        if (label === "subheading") return `${anchorId ? `<a id="${anchorId}"></a>\n` : ""}### ${safe}`;
        if (label === "list_item") return `- ${safe}`;
        if (label === "noise" && !keepNoise) return "";
        return safe;
      })
      .filter(Boolean)
      .join("\n\n");
    onProgress(94, "Construyendo el libro…");
    return { markdown, blocks: linkedResults };
  }
}

export { BookcliWasm as SemanticaWasm };
export type SemanticaLabel = BookcliLabel;
