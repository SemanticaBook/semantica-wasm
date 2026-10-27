import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import {
  convertPdfPath,
  getDefaultLayaModelDirectory,
  loadLayaModel,
  type OutputFormat,
} from "./node.js";
import type { ModelLoadProgress } from "./index.js";
import type { BookMetadata } from "./metadata.js";
import type { ConversionProgress } from "./conversion.js";

type NodeConvertOptions = NonNullable<Parameters<typeof convertPdfPath>[4]>;
export type SemanticaConversion = Awaited<ReturnType<typeof convertPdfPath>>;

export type SemanticaOptions = Omit<NodeConvertOptions, "classifier"> & {
  /** Run OCR on pages whose visible content is not represented by PDF text. */
  useOcr?: boolean;
  /** Load the local Laya model before classification. Defaults to false. */
  useLaya?: boolean;
  /** Directory for downloaded/prepared Laya model files. */
  modelDirectory?: string;
  /** Optional primary base URL for an already prepared model mirror. */
  modelBaseUrl?: string;
  /** Progress for PDF extraction, OCR, classification, and output generation. */
  onProgress?: ConversionProgress;
  /** Progress for downloading/preparing and loading Laya. */
  onModelProgress?: ModelLoadProgress;
  /** Supply an already initialized classifier instead of loading Laya. */
  classifier?: NodeConvertOptions["classifier"];
};

export class SemanticaArtifact {
  constructor(
    readonly blob: Blob,
    readonly filename: string,
    readonly format: OutputFormat,
  ) {}

  /** Save to a file when the path has the matching extension; otherwise save into that directory. */
  async save(outputPath: string): Promise<string> {
    const destination = resolve(outputPath);
    const extension = this.format === "epub" ? ".epub" : ".md";
    const filePath = extname(destination).toLowerCase() === extension
      ? destination
      : join(destination, this.filename);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, new Uint8Array(await this.blob.arrayBuffer()));
    return filePath;
  }
}

/** A single PDF processed once, with ready-to-save EPUB and Markdown outputs. */
export class SemanticaContent {
  constructor(
    readonly sourcePath: string,
    readonly result: SemanticaConversion,
  ) {}

  get pages() { return this.result.pages; }
  get pdfFilename() { return this.result.pdfFilename; }
  get epubFilename() { return this.result.epubFilename; }
  get markdownFilename() { return this.result.markdownFilename; }
}

export class Semantica {
  private readonly layaModels = new Map<string, ReturnType<typeof loadLayaModel>>();

  constructor(private readonly options: SemanticaOptions = {}) {}

  /** Extract and analyze a PDF once. Both output formats are prepared from this result. */
  async convert(
    pdfPath: string,
    overrides: Partial<SemanticaOptions> = {},
  ): Promise<SemanticaContent> {
    const options = { ...this.options, ...overrides };
    const {
      useOcr = false,
      useLaya = false,
      modelDirectory = getDefaultLayaModelDirectory(),
      modelBaseUrl,
      onProgress = () => undefined,
      onModelProgress,
      classifier: suppliedClassifier,
      ...conversionOptions
    } = options;

    const classifier = suppliedClassifier ?? (useLaya
      ? await this.getLayaModel(modelDirectory, onModelProgress, modelBaseUrl)
      : undefined);
    const result = await convertPdfPath(
      pdfPath,
      "epub",
      useOcr,
      onProgress,
      { ...conversionOptions, classifier },
    );
    return new SemanticaContent(resolve(pdfPath), result);
  }

  convertPDFtoMarkdown(content: SemanticaContent): SemanticaArtifact {
    this.assertContent(content);
    return new SemanticaArtifact(content.result.markdownBlob, content.markdownFilename, "markdown");
  }

  convertPDFtoEPUB(content: SemanticaContent): SemanticaArtifact {
    this.assertContent(content);
    return new SemanticaArtifact(content.result.epubBlob, content.epubFilename, "epub");
  }

  private assertContent(content: SemanticaContent): void {
    if (!(content instanceof SemanticaContent)) {
      throw new TypeError("El contenido debe ser el resultado de semantica.convert(rutaPdf).");
    }
  }

  private getLayaModel(modelDirectory: string, onProgress?: ModelLoadProgress, modelBaseUrl?: string) {
    const key = `${resolve(modelDirectory)}|${modelBaseUrl ?? ""}`;
    let loading = this.layaModels.get(key);
    if (!loading) {
      loading = loadLayaModel(resolve(modelDirectory), onProgress, modelBaseUrl);
      this.layaModels.set(key, loading);
      loading.catch(() => this.layaModels.delete(key));
    }
    return loading;
  }
}

export default Semantica;

export type { BookMetadata };
export { convertPdfPath, getDefaultLayaModelDirectory, loadLayaModel };
export type { BookcliLabel } from "./index.js";
