import JSZip from "jszip";
import * as pdfjs from "pdfjs-dist";
import { createWorker, PSM } from "tesseract.js";
import type { BookcliWasmClient } from "./client.js";
import type { ReviewHandler, ClassificationEvent, InferenceSettings } from "./index.js";
import { detectVisualRegions, type TextRegion } from "./vision.js";
import { loadCoverAsset, mergeBookMetadata, searchBookMetadata, type BookCoverCandidate, type BookMetadata, type BookMetadataOptions, type CoverSelection, type CoverSelectionRequest } from "./metadata.js";

export type OutputFormat = "epub" | "markdown";
export type ConversionProgress = (value: number, label: string) => void;
export type BatchConversionProgress = (fileIndex: number, totalFiles: number, value: number, label: string, fileName: string) => void;
export type BatchConversionHandlers = {
  onResult?: (result: Awaited<ReturnType<typeof convertPdf>>, fileIndex: number, totalFiles: number, file: File) => void | Promise<void>;
  onError?: (error: unknown, fileIndex: number, totalFiles: number, file: File) => void | Promise<void>;
};
export type RecoveredImage = {
  id: string;
  page: number;
  left: number;
  top: number;
  width: number;
  height: number;
  anchorAfterBlock: number;
  dataUrl: string;
};
export type SemanticaClassifier = Pick<BookcliWasmClient, "classifyText">;
export type ExtractionMode = "text" | "ocr";
export type { BookCoverCandidate, BookMetadata, BookMetadataOptions, CoverAsset, CoverSelection, CoverSelectionRequest } from "./metadata.js";

type ResolvedCover = { bytes: Uint8Array; mimeType: string };

type PositionedText = TextRegion & { text: string; blockIndex: number };
type PdfTextItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL: boolean;
  fontName?: string;
};
type DigitalParagraph = {
  text: string;
  box: TextRegion;
  fontSize: number;
  bold: boolean;
};
type OcrLine = { text: string; bbox: TextRegion };
const OCR_SHORT_WORDS = new Set("a al de del el en es la las le lo los me mi no o os se si sí su te tu un va y ya it is to of in on at by an as we he my so or be do if up us am im".split(/\s+/));

function cleanOcrLine(text: string) {
  return text
    .replace(/[\p{L}\p{M}]+/gu, (word, offset: number, source: string) => {
      const hyphenated = /[-\u00ad]$/.test(source.slice(0, offset)) ||
        /^[-\u00ad]/.test(source.slice(offset + word.length));
      return word.length <= 2 && !hyphenated && !OCR_SHORT_WORDS.has(word.toLocaleLowerCase("es")) ? " " : word;
    },
    )
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/[\t ]{2,}/g, " ")
    .trim();
}

function normalizeParagraphFormatting(text: string) {
  return text
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph
      .replace(/([\p{L}])[-\u00ad]\s*\n\s*(?=[\p{Ll}])/gu, "$1")
      .replace(/\u00ad/g, "")
      .replace(/\s*\n\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim())
    .filter(Boolean)
    .join("\n\n");
}

function joinOcrLines(current: string, next: string) {
  const left = current.trimEnd();
  const right = next.trimStart();
  if (/\p{L}[-\u00ad]$/u.test(left) && /^\p{Ll}/u.test(right)) {
    return `${left.slice(0, -1)}${right}`;
  }
  return `${left} ${right}`.trim();
}

function splitOcrParagraph(lines: OcrLine[], fallbackText: string, fallbackBox: TextRegion) {
  if (!lines.length) return [{ text: fallbackText.trim(), box: fallbackBox }].filter((item) => item.text);
  const prepared = lines
    .map((line) => ({ ...line, text: cleanOcrLine(line.text) }))
    .filter((line) => line.text);
  const indexSignals = prepared.reduce((count, { text }) =>
    count + (text.match(/\b(?:cap[ií1]tulo|capimlo|pr[oó]logo|ep[ií]logo|ap[eé]ndice|mapa\s+del\s+viaje)\b/gi)?.length ?? 0) +
      (/(?:\.{2,}|…+|·{2,}|_{2,}|[-–—]{3,})|\s\d{1,3}\s*$/u.test(text) ? 1 : 0), 0);
  const isIndexLayout = indexSignals >= 3 || (
    prepared.some(({ text }) => /^(?:(?:índice|indice)(?:\s+(?:general|alfab[eé]tico|onom[aá]stico|anal[ií]tico|tem[aá]tico))?|contenido|tabla\s+de\s+contenido(?:s)?|sumario|table of contents|contents)(?:\s+\d{1,3})?\s*$/i.test(text)) && prepared.length >= 4
  );
  if (isIndexLayout) return prepared.map(({ text, bbox }) => ({ text, box: bbox }));
  const groups: { text: string; box: TextRegion; lineCount: number }[] = [];
  let group: { text: string; box: TextRegion; lineCount: number } | null = null;
  let chapterTitlePending = false;
  let chapterTitleComplete = false;
  for (const line of prepared) {
    const text = line.text;
    const startsChapter = /^(cap[ií]tulo|chapter|parte|libro|unidad)\b/i.test(text);
    const startsDialogue = /^[—–]\s*[¿¡"“]?/u.test(text);
    const chapterRemainder = text.replace(/^(cap[ií]tulo|chapter|parte|libro|unidad)\s+[\w.-]+\s*/i, "").trim();
    const chapterLine = startsChapter && chapterRemainder.length === 0;
    const lineHeight = Math.max(1, line.bbox.bottom - line.bbox.top);
    const previousHeight = group ? Math.max(1, group.box.bottom - group.box.top) / group.lineCount : lineHeight;
    const verticalGap = group ? line.bbox.top - group.box.bottom : 0;
    const separate = Boolean(group) && (
      startsChapter ||
      startsDialogue ||
      chapterTitleComplete ||
      (!chapterTitlePending && verticalGap > Math.max(10, previousHeight * 0.62))
    );
    if (separate && group) {
      groups.push(group);
      group = null;
      chapterTitlePending = false;
      chapterTitleComplete = false;
    }
    group = group
      ? {
          text: joinOcrLines(group.text, text),
          box: {
            left: Math.min(group.box.left, line.bbox.left),
            top: Math.min(group.box.top, line.bbox.top),
            right: Math.max(group.box.right, line.bbox.right),
            bottom: Math.max(group.box.bottom, line.bbox.bottom),
          },
          lineCount: group.lineCount + 1,
        }
      : { text, box: line.bbox, lineCount: 1 };
    if (chapterLine) chapterTitlePending = true;
    else if (chapterTitlePending) {
      chapterTitlePending = false;
      chapterTitleComplete = true;
    } else if (startsChapter) chapterTitleComplete = true;
  }
  if (group) groups.push(group);
  return groups.map(({ text, box }) => ({ text, box }));
}

function normalizedText(text: string) {
  return text.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function hasVisibleContentOutsideText(image: ImageData, regions: TextRegion[]) {
  const cellSize = 8;
  const columns = Math.ceil(image.width / cellSize);
  const rows = Math.ceil(image.height / cellSize);
  const textMask = new Uint8Array(columns * rows);
  for (const region of regions) {
    const left = Math.max(0, Math.floor(region.left / cellSize));
    const top = Math.max(0, Math.floor(region.top / cellSize));
    const right = Math.min(columns - 1, Math.floor(region.right / cellSize));
    const bottom = Math.min(rows - 1, Math.floor(region.bottom / cellSize));
    for (let y = top; y <= bottom; y += 1) {
      textMask.fill(1, y * columns + left, y * columns + right + 1);
    }
  }
  let samples = 0;
  let content = 0;
  for (let y = 0; y < image.height; y += cellSize) {
    for (let x = 0; x < image.width; x += cellSize) {
      if (textMask[Math.floor(y / cellSize) * columns + Math.floor(x / cellSize)]) continue;
      const offset = (y * image.width + x) * 4;
      const red = image.data[offset];
      const green = image.data[offset + 1];
      const blue = image.data[offset + 2];
      const lightness = (red * 3 + green * 6 + blue) / 10;
      const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
      samples += 1;
      if (lightness < 205 || (chroma > 38 && lightness < 245)) content += 1;
    }
  }
  return samples > 0 && content / samples > 0.0005;
}

function detectFontHierarchy(paragraphs: DigitalParagraph[]) {
  const sizes = paragraphs
    .filter((paragraph) => paragraph.text.length > 24 && paragraph.fontSize > 0)
    .map((paragraph) => paragraph.fontSize)
    .sort((a, b) => a - b);
  if (sizes.length < 4) return null;
  const median = sizes[Math.floor(sizes.length / 2)];
  const headingIndexes = new Set<number>();
  paragraphs.forEach((paragraph, index) => {
    const text = paragraph.text.replace(/\s+/g, " ").trim();
    if (text.length > 180 || text.length < 2) return;
    const clearlyLarger = paragraph.fontSize >= median * 1.22;
    const boldHeading = paragraph.bold && paragraph.fontSize >= median * 1.08 && !/[.!?]$/.test(text);
    if (clearlyLarger || boldHeading) headingIndexes.add(index);
  });
  return headingIndexes.size >= 2 && headingIndexes.size < paragraphs.length * 0.4
    ? { median, headingIndexes }
    : null;
}

function pageParts(text: string) {
  return text.split(/\n\s*\n+/).map((part) => part.trim()).filter(Boolean);
}

function imageMarkdown(image: RecoveredImage) {
  return `![Ilustración de la página ${image.page}](${image.dataUrl})`;
}

function interleaveImages(
  blocks: { text: string; sourceIndex: number }[],
  images: RecoveredImage[],
) {
  const result = images.filter((image) => image.anchorAfterBlock < 0).map(imageMarkdown);
  for (const block of blocks) {
    if (block.text) result.push(block.text);
    result.push(
      ...images
        .filter((image) => image.anchorAfterBlock === block.sourceIndex)
        .map(imageMarkdown),
    );
  }
  return result.join("\n\n");
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] ?? character,
  );
}

function renderInternalLinks(escapedText: string) {
  return escapedText.replace(/\[([^\]]+)\]\(#([a-z0-9-]+)\)/gi, '<a href="#$2">$1</a>');
}

function structureText(text: string): string {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  return paragraphs
    .map((paragraph, index) => {
      const compact = paragraph.replace(/\s+/g, " ");
      if (index === 0 && compact.length < 100) return `# ${compact}`;
      if (compact.length < 70 && !/[.!?]$/.test(compact))
        return `## ${compact}`;
      return compact;
    })
    .join("\n\n");
}

async function makeEpub(
  title: string,
  text: string,
  isStructured = false,
  images: RecoveredImage[] = [],
  metadata: BookMetadata = { title, authors: [] },
  cover?: ResolvedCover,
): Promise<Blob> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  const imageManifest: string[] = [];
  let coverSpine = "";
  if (cover) {
    const extension = cover.mimeType === "image/png" ? "png" : "jpg";
    const mediaType = extension === "png" ? "image/png" : "image/jpeg";
    zip.file(`OEBPS/images/cover.${extension}`, cover.bytes);
    zip.file("OEBPS/cover.xhtml", `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${escapeHtml(metadata.title)}</title><meta charset="utf-8"/></head><body><img src="images/cover.${extension}" alt="Portada de ${escapeHtml(metadata.title)}" style="display:block;max-width:100%;max-height:100vh;margin:0 auto"/></body></html>`);
    imageManifest.push(`<item id="cover-image" href="images/cover.${extension}" media-type="${mediaType}" properties="cover-image"/><item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>`);
    coverSpine = `<itemref idref="cover-page"/>`;
  }
  const body = (isStructured ? text : structureText(text))
    .split("\n\n")
    .map((line) => {
      const imageMatch = /^!\[([^\]]*)\]\((data:image\/(?:png|jpeg);base64,[^)]+)\)$/.exec(line.trim());
      if (imageMatch) {
        const image = images.find((candidate) => candidate.dataUrl === imageMatch[2]);
        if (!image) return `<p>${escapeHtml(line)}</p>`;
        const extension = imageMatch[2].startsWith("data:image/png") ? "png" : "jpg";
        const fileName = `${image.id}.${extension}`;
        const encoded = imageMatch[2].slice(imageMatch[2].indexOf(",") + 1);
        const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
        zip.file(`OEBPS/images/${fileName}`, bytes);
        imageManifest.push(`<item id="image-${imageManifest.length + 1}" href="images/${fileName}" media-type="image/${extension === "jpg" ? "jpeg" : extension}"/>`);
        return `<figure><img src="images/${fileName}" alt="${escapeHtml(imageMatch[1])}"/></figure>`;
      }
      const heading = /^(?:<a id="([a-z0-9-]+)"><\/a>\n)?(#{1,3})\s+([\s\S]+)$/i.exec(line.trim());
      if (heading) {
        const [, id, marks, content] = heading;
        const level = marks.length;
        return `<h${level}${id ? ` id="${id}"` : ""}>${escapeHtml(content)}</h${level}>`;
      }
      const listItem = /^-\s+(.+)$/s.exec(line.trim());
      if (listItem) {
        const linked = /^\[([^\]]+)\]\(#([a-z0-9-]+)\)$/i.exec(listItem[1]);
        return `<ul><li>${linked ? `<a href="#${linked[2]}">${escapeHtml(linked[1])}</a>` : escapeHtml(listItem[1])}</li></ul>`;
      }
      return `<p>${renderInternalLinks(escapeHtml(line)).replace(/\n/g, "<br/>")}</p>`;
    })
    .join("\n");
  zip.file(
    "OEBPS/chapter.xhtml",
    `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${escapeHtml(title)}</title><meta charset="utf-8"/></head><body>${body}</body></html>`,
  );
  zip.file(
    "OEBPS/nav.xhtml",
    `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contenido</title></head><body><nav epub:type="toc"><h1>Contenido</h1><ol><li><a href="chapter.xhtml">${escapeHtml(title)}</a></li></ol></nav></body></html>`,
  );
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${escapeHtml(metadata.language || "und")}"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">urn:uuid:${crypto.randomUUID()}</dc:identifier><dc:title>${escapeHtml(metadata.title || title)}</dc:title>${metadata.authors.map((author) => `<dc:creator>${escapeHtml(author)}</dc:creator>`).join("")}${metadata.isbn ? `<dc:identifier id="isbn">${escapeHtml(metadata.isbn)}</dc:identifier>` : ""}${metadata.publisher ? `<dc:publisher>${escapeHtml(metadata.publisher)}</dc:publisher>` : ""}${metadata.publishedDate ? `<dc:date>${escapeHtml(metadata.publishedDate)}</dc:date>` : ""}${metadata.description ? `<dc:description>${escapeHtml(metadata.description)}</dc:description>` : ""}<dc:language>${escapeHtml(metadata.language || "und")}</dc:language></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${imageManifest.join("")}</manifest><spine>${coverSpine}<itemref idref="chapter"/></spine></package>`,
  );
  return zip.generateAsync({ type: "blob", mimeType: "application/epub+zip" });
}

export async function convertPdf(
  file: File,
  format: OutputFormat,
  useOcr: boolean,
  onProgress: ConversionProgress,
  options: {
    classifier?: SemanticaClassifier;
    onReview?: ReviewHandler;
    onOcrText?: (text: string) => void;
    onExtractionMode?: (mode: ExtractionMode) => void;
    bookMetadata?: BookMetadataOptions;
    onCoverSelection?: (request: CoverSelectionRequest) => Promise<CoverSelection>;
    onClassification?: (event: ClassificationEvent) => void;
    onImageRecovered?: (image: RecoveredImage) => void;
    inferenceSettings?: Partial<InferenceSettings> & { ocrLanguages?: string; ocrRenderScale?: number; ocrPageMode?: "auto" | "single-column" };
  } = {},
): Promise<{
  blob: Blob;
  filename: string;
  pages: number;
  pdfBlob: Blob;
  epubBlob: Blob;
  markdownBlob: Blob;
  pdfFilename: string;
  epubFilename: string;
  markdownFilename: string;
}> {
  const document = await pdfjs.getDocument({ data: await file.arrayBuffer() })
    .promise;
  let pages: string[] = [];
  const digitalPages: DigitalParagraph[][] = [];
  const recoveredImages: RecoveredImage[] = [];
  let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
  let activePage = 1;
  let lastProgress = 0;
  let recoveredText = "";
  let globalBlockOffset = 0;
  let ocrPageCount = 0;
  let originalCoverDataUrl: string | undefined;
  const reportProgress = (value: number, label: string) => {
    lastProgress = Math.max(lastProgress, Math.min(82, Math.round(value)));
    onProgress(lastProgress, label);
  };
  try {
    for (let number = 1; number <= document.numPages; number += 1) {
      activePage = number;
      options.onExtractionMode?.("text");
      reportProgress(
        ((number - 1) / document.numPages) * 82,
        `Extrayendo texto del PDF · página ${number} de ${document.numPages}`,
      );
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const renderScale = Math.max(1.5, Math.min(3, options.inferenceSettings?.ocrRenderScale ?? 2.2));
      const viewport = page.getViewport({ scale: renderScale });
      const canvas = globalThis.document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("No se pudo preparar el lienzo para analizar la página.");
      await page.render({ canvasContext: context, viewport }).promise;
      if (number === 1) originalCoverDataUrl = canvas.toDataURL("image/jpeg", 0.92);

      const pdfTextItems: PdfTextItem[] = content.items
        .filter((item) => "str" in item && Boolean(item.str.trim()))
        .map((item) => item as unknown as PdfTextItem);
      const pdfTextRegions: TextRegion[] = pdfTextItems.map((item) => {
        const [va, vb, vc, vd, ve, vf] = viewport.transform;
        const [, , ic, id, ie, iff] = item.transform;
        const left = va * ie + vc * iff + ve;
        const baseline = vb * ie + vd * iff + vf;
        const glyphX = va * ic + vc * id;
        const glyphY = vb * ic + vd * id;
        const textHeight = Math.max(1, Math.hypot(glyphX, glyphY));
        const right = left + Math.max(textHeight * 0.3, item.width * viewport.scale);
        return { left, top: baseline - textHeight, right, bottom: baseline };
      });
      const digitalParagraphs: DigitalParagraph[] = [];
      let currentParagraph = "";
      let paragraphBox: TextRegion | null = null;
      let paragraphFontSize = 0;
      let paragraphFontSamples = 0;
      let paragraphBoldSamples = 0;
      let previousBaseline: number | null = null;
      let previousHeight = 0;
      const pushDigitalParagraph = () => {
        if (currentParagraph.trim() && paragraphBox) {
          digitalParagraphs.push({
            text: currentParagraph.trim(),
            box: paragraphBox,
            fontSize: paragraphFontSamples ? paragraphFontSize / paragraphFontSamples : 0,
            bold: paragraphBoldSamples >= Math.max(1, paragraphFontSamples * 0.65),
          });
        }
      };
      pdfTextItems.forEach((item, index) => {
        const region = pdfTextRegions[index];
        const baseline = region.bottom;
        const height = Math.max(1, region.bottom - region.top);
        const paragraphGap = previousBaseline !== null &&
          baseline - previousBaseline > Math.max(previousHeight, height) * 1.8;
        if (paragraphGap && currentParagraph.trim() && paragraphBox) {
          pushDigitalParagraph();
          currentParagraph = "";
          paragraphBox = null;
          paragraphFontSize = 0;
          paragraphFontSamples = 0;
          paragraphBoldSamples = 0;
        }
        currentParagraph += `${item.str}${item.hasEOL ? "\n" : " "}`;
        const transformFontSize = Math.hypot(item.transform[0] ?? 0, item.transform[1] ?? 0) ||
          Math.hypot(item.transform[2] ?? 0, item.transform[3] ?? 0);
        if (transformFontSize > 0) {
          paragraphFontSize += transformFontSize;
          paragraphFontSamples += 1;
        }
        const fontFamily = item.fontName ? content.styles[item.fontName]?.fontFamily ?? item.fontName : "";
        if (/bold|semibold|demi|black|heavy/i.test(fontFamily)) paragraphBoldSamples += 1;
        paragraphBox = paragraphBox
          ? {
              left: Math.min(paragraphBox.left, region.left),
              top: Math.min(paragraphBox.top, region.top),
              right: Math.max(paragraphBox.right, region.right),
              bottom: Math.max(paragraphBox.bottom, region.bottom),
            }
          : region;
        previousBaseline = baseline;
        previousHeight = height;
      });
      pushDigitalParagraph();
      let pageText = digitalParagraphs.map((paragraph) => paragraph.text).join("\n\n");
      let textRegions = pdfTextRegions;
      let recognizedParagraphs: { text: string; box: TextRegion }[] = [];
      const pageImageData = context.getImageData(0, 0, canvas.width, canvas.height);
      const sparseImageContent = pageText.length < 180 &&
        hasVisibleContentOutsideText(pageImageData, pdfTextRegions);
      // OCR only sparse pages whose visible content is not represented by the
      // embedded text layer. Text rich PDFs bypass Tesseract entirely.
      let pageUsedOcr = false;
      if (useOcr && sparseImageContent) {
        worker ??= await createWorker(options.inferenceSettings?.ocrLanguages || "spa+eng", 1, {
          logger: (event) => {
            if (event.status === "recognizing text") {
              reportProgress(
                ((activePage - 1 + event.progress) / document.numPages) * 82,
                `Reconociendo texto con OCR · página ${activePage} de ${document.numPages}`,
              );
            }
          },
        });
        await worker.setParameters({
          tessedit_pageseg_mode: options.inferenceSettings?.ocrPageMode === "auto"
            ? PSM.AUTO
            : PSM.SINGLE_COLUMN,
        });
        const recognition = await worker.recognize(canvas);
        pageUsedOcr = true;
        ocrPageCount += 1;
        options.onExtractionMode?.("ocr");
        const paragraphs = recognition.data.blocks?.flatMap((block) => block.paragraphs) ?? [];
        recognizedParagraphs = paragraphs.flatMap((paragraph) => splitOcrParagraph(
          paragraph.lines.map((line) => ({
            text: line.text,
            bbox: {
              left: line.bbox.x0,
              top: line.bbox.y0,
              right: line.bbox.x1,
              bottom: line.bbox.y1,
            },
          })),
          paragraph.text,
          {
            left: paragraph.bbox.x0,
            top: paragraph.bbox.y0,
            right: paragraph.bbox.x1,
            bottom: paragraph.bbox.y1,
          },
        ));
        const recognizedText = recognizedParagraphs.length
          ? recognizedParagraphs.map((paragraph) => paragraph.text).join("\n\n")
          : recognition.data.text.trim();
        if (recognizedText.length > pageText.length * 1.15 || pageText.length < 24) {
          pageText = recognizedText;
        }
        const words = recognition.data.blocks?.flatMap((block) =>
          block.paragraphs.flatMap((paragraph) =>
            paragraph.lines.flatMap((line) => line.words),
          ),
        ) ?? [];
        const ocrTextRegions = words.map((word) => ({
          left: word.bbox.x0,
          top: word.bbox.y0,
          right: word.bbox.x1,
          bottom: word.bbox.y1,
        }));
        if (ocrTextRegions.length) textRegions = ocrTextRegions;
        else if (recognizedParagraphs.length) textRegions = recognizedParagraphs.map((paragraph) => paragraph.box);
      }

      pageText = normalizeParagraphFormatting(pageText);
      digitalPages.push(pageUsedOcr ? [] : digitalParagraphs);
      const parts = pageParts(pageText);
      const unionRegion = textRegions.reduce<TextRegion | null>((union, box) =>
        union
          ? {
              left: Math.min(union.left, box.left),
              top: Math.min(union.top, box.top),
              right: Math.max(union.right, box.right),
              bottom: Math.max(union.bottom, box.bottom),
            }
          : { ...box }, null);
      const positionedText: PositionedText[] = parts.map((text, index) => {
        let box = unionRegion;
        if (recognizedParagraphs.length === parts.length) {
          box = recognizedParagraphs[index].box;
        } else if (digitalParagraphs.length === parts.length) {
          box = digitalParagraphs[index].box;
        } else if (recognizedParagraphs.length > 0) {
          const normalized = normalizedText(text);
          const match = recognizedParagraphs.find((paragraph) =>
            normalizedText(paragraph.text).includes(normalized.slice(0, 36)),
          );
          if (match) box = match.box;
        }
        return {
          text,
          blockIndex: globalBlockOffset + index,
          left: box?.left ?? 0,
          top: box?.top ?? 0,
          right: box?.right ?? canvas.width,
          bottom: box?.bottom ?? canvas.height,
        };
      });

      const sparseScannedPage = pageText.length < 96 &&
        hasVisibleContentOutsideText(pageImageData, textRegions) &&
        (pageUsedOcr || pdfTextItems.length === 0);
      if (sparseScannedPage) {
        const scan: RecoveredImage = {
          id: `scan-p${number}`,
          page: number,
          left: 0,
          top: 0,
          width: 1,
          height: 1,
          anchorAfterBlock: positionedText.at(-1)?.blockIndex ?? globalBlockOffset - 1,
          dataUrl: canvas.toDataURL("image/jpeg", 0.9),
        };
        recoveredImages.push(scan);
        options.onImageRecovered?.(scan);
        reportProgress(((number - 1) / document.numPages) * 82, `Página escaneada recuperada · página ${number} de ${document.numPages}`);
      } else if (textRegions.length || pageText.length < 320) {
        const regions = detectVisualRegions(pageImageData, textRegions);
        regions.forEach((region, index) => {
          const coversPage =
            (region.right - region.left) / canvas.width > 0.88 &&
            (region.bottom - region.top) / canvas.height > 0.88;
          if (coversPage && pageText.length > 80) return;
          const crop = globalThis.document.createElement("canvas");
          crop.width = region.right - region.left;
          crop.height = region.bottom - region.top;
          const cropContext = crop.getContext("2d");
          if (!cropContext || crop.width < 32 || crop.height < 32) return;
          cropContext.drawImage(
            canvas,
            region.left,
            region.top,
            crop.width,
            crop.height,
            0,
            0,
            crop.width,
            crop.height,
          );
          const centerY = (region.top + region.bottom) / 2;
          const nearest = positionedText
            .map((entry) => ({
              entry,
              distance: Math.abs((entry.top + entry.bottom) / 2 - centerY),
            }))
            .sort((a, b) => a.distance - b.distance)[0]?.entry;
          const image: RecoveredImage = {
            id: `figure-p${number}-${index + 1}`,
            page: number,
            left: region.left / canvas.width,
            top: region.top / canvas.height,
            width: crop.width / canvas.width,
            height: crop.height / canvas.height,
            anchorAfterBlock: nearest?.blockIndex ?? globalBlockOffset - 1,
            dataUrl: crop.toDataURL("image/jpeg", 0.88),
          };
          recoveredImages.push(image);
          options.onImageRecovered?.(image);
          reportProgress(
            ((number - 1) / document.numPages) * 82,
            `Ilustración recuperada · página ${number} de ${document.numPages}`,
          );
        });
      }
      pages.push(pageText);
      globalBlockOffset += parts.length;
      if (pageText) {
        recoveredText += `${recoveredText ? "\n\n" : ""}${pageText}`;
        options.onOcrText?.(recoveredText);
      }
      reportProgress(
        Math.round((number / document.numPages) * 82),
        pageUsedOcr
          ? `OCR e imágenes · página ${number} de ${document.numPages}`
          : `Extrayendo texto del PDF · página ${number} de ${document.numPages}`,
      );
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    await worker?.terminate();
  }
  const title = file.name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ");
  const digitalParagraphs = digitalPages.flat();
  const detectedHierarchy = ocrPageCount === 0 ? detectFontHierarchy(digitalParagraphs) : null;
  if (detectedHierarchy) {
    let paragraphIndex = 0;
    pages = digitalPages.map((paragraphs) => paragraphs.map((paragraph) => {
      const index = paragraphIndex++;
      const text = normalizeParagraphFormatting(paragraph.text);
      if (!detectedHierarchy.headingIndexes.has(index)) return text;
      const level = paragraph.fontSize >= detectedHierarchy.median * 1.5 ? "#" : "##";
      return `${level} ${text}`;
    }).join("\n\n"));
  }
  const body = pages
    .map((text) => text.trim())
    .filter(Boolean)
    .join("\n\n");
  if (!body && recoveredImages.length === 0)
    throw new Error(
      "No se encontró texto. Activa OCR para procesar PDFs escaneados.",
    );
  onProgress(83, detectedHierarchy
    ? "Jerarquía tipográfica detectada; conservando la estructura del PDF…"
    : options.classifier
      ? "Analizando la estructura con Laya…"
      : "Organizando estructura…");
  let structuredText: string;
  let epubStructuredText: string;
  if (options.classifier && !detectedHierarchy) {
    const classified = await options.classifier.classifyText(
          body,
          (value, label) =>
            onProgress(83 + Math.round((value / 100) * 7), label),
          options.onReview,
          0.85,
          true,
          options.onClassification,
          options.inferenceSettings,
        );
    const formattedBlocks = classified.blocks.map((block, sourceIndex) => ({
      sourceIndex: block.sourceIndex ?? sourceIndex,
      text: block.isTocEntry
        ? `- ${block.targetId ? `[${block.text.replace(/[\[\]]/g, "\\$&")}](#${block.targetId})` : block.text}`
        : block.label === "title"
        ? `# ${block.text}`
        : block.label === "heading"
          ? `## ${block.text}`
          : block.label === "subheading"
            ? `### ${block.text}`
            : block.label === "list_item"
              ? `- ${block.text}`
              : block.text,
    })).map((block, index) => {
      const anchorId = classified.blocks[index].anchorId;
      return anchorId ? { ...block, text: `<a id="${anchorId}"></a>\n${block.text}` } : block;
    });
    structuredText = interleaveImages(formattedBlocks, recoveredImages);
    epubStructuredText = interleaveImages(
      formattedBlocks.map((block, index) => ({
        ...block,
        text: classified.blocks[index].label === "noise" ? "" : block.text,
      })),
      recoveredImages,
    );
  } else {
    const formattedBlocks = pageParts(detectedHierarchy ? body : structureText(body)).map((text, sourceIndex) => ({
      text,
      sourceIndex,
    }));
    structuredText = interleaveImages(formattedBlocks, recoveredImages);
    epubStructuredText = structuredText;
  }
  let metadata: BookMetadata = {
    title: title.trim() || "Libro sin título",
    authors: [],
    ...options.bookMetadata?.metadata,
  };
  let selectedCover = options.bookMetadata?.cover ?? null;
  let automaticCoverSelection = false;
  if (options.bookMetadata?.mode === "auto" || options.onCoverSelection) {
    onProgress(92, "Buscando portadas y metadatos del libro…");
    const candidates = await searchBookMetadata(metadata.title, {
      googleBooksApiKey: options.bookMetadata?.googleBooksApiKey,
    });
    if (options.onCoverSelection) {
      const selectionRequest: CoverSelectionRequest = {
        query: metadata.title,
        initialMetadata: metadata,
        candidates,
        originalCoverDataUrl,
      };
      const selection = await options.onCoverSelection(selectionRequest);
      metadata = mergeBookMetadata(metadata, selection.metadata);
      selectedCover = selection.cover ?? null;
      automaticCoverSelection = Boolean(selection.automatic);
    } else if (options.bookMetadata?.mode === "auto" && candidates[0]) {
      selectedCover = { url: candidates[0].coverUrl };
      metadata = mergeBookMetadata(metadata, candidates[0].metadata);
    }
  } else if (options.bookMetadata?.mode === "manual") {
    metadata = mergeBookMetadata(metadata, options.bookMetadata.metadata);
  }
  let resolvedCover: ResolvedCover | undefined;
  if (selectedCover) {
    try {
      resolvedCover = await loadCoverAsset(selectedCover);
    } catch (cause) {
      if (options.bookMetadata?.mode === "auto" && !options.onCoverSelection) {
        const candidates = await searchBookMetadata(metadata.title, {
          googleBooksApiKey: options.bookMetadata.googleBooksApiKey,
        });
        for (const candidate of candidates.slice(1)) {
          try {
            resolvedCover = await loadCoverAsset({ url: candidate.coverUrl });
            metadata = mergeBookMetadata(metadata, candidate.metadata);
            break;
          } catch {
            // Try the next compatible result; metadata remains usable without a cover.
          }
        }
      } else if (automaticCoverSelection && originalCoverDataUrl) {
        resolvedCover = await loadCoverAsset({ dataUrl: originalCoverDataUrl, mimeType: "image/jpeg" });
      } else {
        throw cause;
      }
    }
  }
  const outputBaseName = (metadata.title || title).replace(/[\\/:*?"<>|]+/g, " ").trim() || title;
  const markdownFilename = `${outputBaseName}.md`;
  const epubFilename = `${outputBaseName}.epub`;
  const yamlQuote = (value: string) => JSON.stringify(value);
  const markdownBlob = new Blob(
    [
      `---\ntitle: ${yamlQuote(metadata.title)}\n${metadata.authors.length ? `authors:\n${metadata.authors.map((author) => `  - ${yamlQuote(author)}`).join("\n")}\n` : ""}${metadata.publisher ? `publisher: ${yamlQuote(metadata.publisher)}\n` : ""}${metadata.publishedDate ? `date: ${yamlQuote(metadata.publishedDate)}\n` : ""}${metadata.language ? `language: ${yamlQuote(metadata.language)}\n` : ""}${metadata.isbn ? `isbn: ${yamlQuote(metadata.isbn)}\n` : ""}${metadata.description ? `description: ${yamlQuote(metadata.description)}\n` : ""}source: ${yamlQuote(file.name)}\npages: ${document.numPages}\n---\n\n${structuredText}\n`,
    ],
    { type: "text/markdown;charset=utf-8" },
  );
  const epubBlob = await makeEpub(metadata.title || title, epubStructuredText, true, recoveredImages, metadata, resolvedCover);
  const filename = format === "markdown" ? markdownFilename : epubFilename;
  return {
    blob: format === "markdown" ? markdownBlob : epubBlob,
    filename,
    pages: document.numPages,
    pdfBlob: file.slice(0, file.size, "application/pdf"),
    epubBlob,
    markdownBlob,
    pdfFilename: file.name,
    epubFilename,
    markdownFilename,
  };
}

/** Process a list in order and let callers consume each result before the next PDF starts. */
export async function processPdfBatch(
  files: File[],
  format: OutputFormat,
  useOcr: boolean,
  onProgress: BatchConversionProgress = () => undefined,
  options: Parameters<typeof convertPdf>[4] = {},
  handlers: BatchConversionHandlers = {},
): Promise<void> {
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    onProgress(index + 1, files.length, 0, "Preparando el PDF…", file.name);
    try {
      const result = await convertPdf(file, format, useOcr, (value, label) => {
        onProgress(index + 1, files.length, value, label, file.name);
      }, options);
      await handlers.onResult?.(result, index + 1, files.length, file);
    } catch (error) {
      if (!handlers.onError) throw error;
      await handlers.onError(error, index + 1, files.length, file);
    }
  }
}

/** Convert a list in order and return all results. Use processPdfBatch to stream results. */
export async function convertPdfBatch(
  files: File[],
  format: OutputFormat,
  useOcr: boolean,
  onProgress: BatchConversionProgress = () => undefined,
  options: Parameters<typeof convertPdf>[4] = {},
) {
  const results: Awaited<ReturnType<typeof convertPdf>>[] = [];
  await processPdfBatch(files, format, useOcr, onProgress, options, {
    onResult: (result) => { results.push(result); },
  });
  return results;
}
