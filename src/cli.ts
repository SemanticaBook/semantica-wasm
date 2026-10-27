#!/usr/bin/env node
import { basename, extname, join, resolve } from "node:path";
import type { SemanticaOptions } from "./semantica.js";
import type { BookMetadata } from "./metadata.js";

const VERSION = "0.1.1";
const HELP = `Semantica ${VERSION} · convierte PDFs a EPUB y Markdown

Uso:
  semanticabook convert <archivo.pdf...> [opciones]
  semanticabook model download [opciones]

Opciones:
  -o, --output <directorio>   Directorio de salida (predeterminado: ./semantica-output)
  -f, --format <formato>      epub, markdown o both (predeterminado: both)
      --ocr                   Activa OCR para páginas escaneadas o con texto insuficiente
      --laya                  Clasifica con Laya; descarga el modelo listo si falta
      --model-dir <directorio> Directorio del modelo (por defecto, caché del usuario)
      --title <título>        Título manual del libro
      --author <nombre>       Autor manual (se puede repetir)
      --publisher <nombre>    Editorial manual
      --year <año>            Año de publicación manual
      --cover <archivo>       Portada JPEG o PNG
  -h, --help                  Muestra esta ayuda
  -v, --version               Muestra la versión

Ejemplos:
  semanticabook convert libro.pdf --format both --output ./resultado
  semanticabook convert *.pdf --ocr --laya --format epub -o ./epubs
  semanticabook convert libro.pdf --title "Mi libro" --author "Una autora" --cover portada.jpg
`;

type ParsedArguments = {
  files: string[];
  outputDirectory: string;
  format: "epub" | "markdown" | "both";
  useOcr: boolean;
  useLaya: boolean;
  modelDirectory?: string;
  title?: string;
  authors: string[];
  publisher?: string;
  year?: string;
  cover?: string;
};

function parseArguments(args: string[]): ParsedArguments {
  const parsed: ParsedArguments = {
    files: [],
    outputDirectory: "./semantica-output",
    format: "both",
    useOcr: false,
    useLaya: false,
    authors: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const next = () => {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`Falta un valor después de ${argument}.`);
      index += 1;
      return value;
    };
    if (argument === "--output" || argument === "-o") parsed.outputDirectory = next();
    else if (argument === "--format" || argument === "-f") {
      const value = next().toLowerCase();
      if (value !== "epub" && value !== "markdown" && value !== "both") {
        throw new Error(`Formato no válido: ${value}. Usa epub, markdown o both.`);
      }
      parsed.format = value;
    } else if (argument === "--ocr") parsed.useOcr = true;
    else if (argument === "--laya") parsed.useLaya = true;
    else if (argument === "--model-dir") parsed.modelDirectory = next();
    else if (argument === "--title") parsed.title = next();
    else if (argument === "--author") parsed.authors.push(next());
    else if (argument === "--publisher") parsed.publisher = next();
    else if (argument === "--year") parsed.year = next();
    else if (argument === "--cover") parsed.cover = next();
    else if (argument.startsWith("-")) throw new Error(`Opción desconocida: ${argument}. Usa --help para ver las opciones.`);
    else parsed.files.push(argument);
  }
  if (parsed.files.length === 0) throw new Error("Indica al menos un archivo PDF.");
  return parsed;
}

function metadataOptions(args: ParsedArguments): BookMetadata | undefined {
  if (!args.title && args.authors.length === 0 && !args.publisher && !args.year) return undefined;
  return {
    title: args.title ?? "",
    authors: args.authors,
    publisher: args.publisher,
    publishedDate: args.year,
  };
}

async function runConvert(args: string[]): Promise<void> {
  const parsed = parseArguments(args);
  const { default: Semantica } = await import("./semantica.js");
  const metadata = metadataOptions(parsed);
  const options: SemanticaOptions = {
    useOcr: parsed.useOcr,
    useLaya: parsed.useLaya,
    modelDirectory: parsed.modelDirectory,
    bookMetadata: metadata || parsed.cover
      ? { mode: "manual", metadata, cover: parsed.cover ? { path: parsed.cover } : undefined }
      : undefined,
    onModelProgress: (label, percent) => console.log(`[Laya ${percent}%] ${label}`),
  };
  const semantica = new Semantica(options);
  const outputRoot = resolve(parsed.outputDirectory);
  for (let index = 0; index < parsed.files.length; index += 1) {
    const pdfPath = resolve(parsed.files[index]);
    const baseName = basename(pdfPath, extname(pdfPath));
    const outputDirectory = parsed.files.length === 1 ? outputRoot : join(outputRoot, baseName);
    console.log(`\n[${index + 1}/${parsed.files.length}] Procesando ${pdfPath}`);
    const content = await semantica.convert(pdfPath, {
      onProgress: (progress, label) => {
        process.stdout.write(`\r${String(progress).padStart(3)}% ${label}`);
      },
    });
    process.stdout.write("\n");

    if (parsed.format === "epub" || parsed.format === "both") {
      const saved = await semantica.convertPDFtoEPUB(content).save(outputDirectory);
      console.log(`EPUB: ${saved}`);
    }
    if (parsed.format === "markdown" || parsed.format === "both") {
      const saved = await semantica.convertPDFtoMarkdown(content).save(outputDirectory);
      console.log(`Markdown: ${saved}`);
    }
    console.log(`Páginas: ${content.pages}`);
  }
}

async function runModel(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Uso: semanticabook model download [--model-dir <directorio>]");
    return;
  }
  const [action, ...options] = args;
  if (action === "--help" || action === "-h" || !action) {
    console.log("Uso: semanticabook model download [--model-dir <directorio>]");
    return;
  }
  if (action !== "download") throw new Error(`Acción de modelo desconocida: ${action}. Usa 'semanticabook model --help'.`);
  const { getDefaultLayaModelDirectory, prepareLayaModel } = await import("./node.js");
  let modelDirectory = getDefaultLayaModelDirectory();
  for (let index = 0; index < options.length; index += 1) {
    if (options[index] === "--model-dir") {
      const value = options[index + 1];
      if (!value) throw new Error("Falta un valor después de --model-dir.");
      modelDirectory = value;
      index += 1;
    } else {
      throw new Error(`Opción de modelo desconocida: ${options[index]}.`);
    }
  }
  const prepared = await prepareLayaModel(resolve(modelDirectory), (label, percent) => {
    console.log(`[Laya ${percent}%] ${label}`);
  });
  console.log(prepared ? `Modelo preparado en ${resolve(modelDirectory)}` : `El modelo ya está listo en ${resolve(modelDirectory)}`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(HELP);
    return;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    console.log(VERSION);
    return;
  }
  if (command === "model") {
    await runModel(args);
    return;
  }
  if (command !== "convert") throw new Error(`Comando desconocido: ${command}. Usa --help para ver el uso.`);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }
  await runConvert(args);
}

main().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
