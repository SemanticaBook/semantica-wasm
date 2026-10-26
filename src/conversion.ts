import JSZip from "jszip";
import * as pdfjs from "pdfjs-dist";
import { createWorker, PSM } from "tesseract.js";
import type { BookcliWasmClient } from "./client.js";
import type { ReviewHandler, ClassificationEvent, InferenceSettings } from "./index.js";
import { detectVisualRegions, type TextRegion } from "./vision.js";

export type OutputFormat = "epub" | "markdown";
export type ConversionProgress = (value: number, label: string) => void;
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

type PositionedText = TextRegion & { text: string; blockIndex: number };
type PdfTextItem = {
  str: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL: boolean;
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

function hasVisiblePageContent(image: ImageData) {
  const stride = 4;
  let samples = 0;
  let content = 0;
  for (let y = 0; y < image.height; y += stride) {
    for (let x = 0; x < image.width; x += stride) {
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
): Promise<Blob> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  const imageManifest: string[] = [];
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
    `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="es"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">urn:uuid:${crypto.randomUUID()}</dc:identifier><dc:title>${escapeHtml(title)}</dc:title><dc:language>es</dc:language></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${imageManifest.join("")}</manifest><spine><itemref idref="chapter"/></spine></package>`,
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
  const pages: string[] = [];
  const recoveredImages: RecoveredImage[] = [];
  let worker: Awaited<ReturnType<typeof createWorker>> | undefined;
  let activePage = 1;
  let lastProgress = 0;
  let recoveredText = "";
  let globalBlockOffset = 0;
  const reportProgress = (value: number, label: string) => {
    lastProgress = Math.max(lastProgress, Math.min(82, Math.round(value)));
    onProgress(lastProgress, label);
  };
  try {
    for (let number = 1; number <= document.numPages; number += 1) {
      activePage = number;
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
      const digitalParagraphs: { text: string; box: TextRegion }[] = [];
      let currentParagraph = "";
      let paragraphBox: TextRegion | null = null;
      let previousBaseline: number | null = null;
      let previousHeight = 0;
      pdfTextItems.forEach((item, index) => {
        const region = pdfTextRegions[index];
        const baseline = region.bottom;
        const height = Math.max(1, region.bottom - region.top);
        const paragraphGap = previousBaseline !== null &&
          baseline - previousBaseline > Math.max(previousHeight, height) * 1.8;
        if (paragraphGap && currentParagraph.trim() && paragraphBox) {
          digitalParagraphs.push({ text: currentParagraph.trim(), box: paragraphBox });
          currentParagraph = "";
          paragraphBox = null;
        }
        currentParagraph += `${item.str}${item.hasEOL ? "\n" : " "}`;
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
      if (currentParagraph.trim() && paragraphBox) {
        digitalParagraphs.push({ text: currentParagraph.trim(), box: paragraphBox });
      }
      let pageText = digitalParagraphs.map((paragraph) => paragraph.text).join("\n\n");
      let textRegions = pdfTextRegions;
      let recognizedParagraphs: { text: string; box: TextRegion }[] = [];
      // Scanned pages can contain a small/incomplete embedded text layer (for
      // example only a chapter heading). OCR those pages instead of trusting it.
      if (pageText.length < 320 && useOcr) {
        worker ??= await createWorker(options.inferenceSettings?.ocrLanguages || "spa+eng", 1, {
          logger: (event) => {
            if (event.status === "recognizing text") {
              reportProgress(
                ((activePage - 1 + event.progress) / document.numPages) * 82,
                `OCR · página ${activePage} de ${document.numPages}`,
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

      const pageImageData = context.getImageData(0, 0, canvas.width, canvas.height);
      const sparseScannedPage = pageText.length < 96 && hasVisiblePageContent(pageImageData);
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
        `OCR e imágenes · página ${number} de ${document.numPages}`,
      );
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    await worker?.terminate();
  }
  const title = file.name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ");
  const body = pages
    .map((text) => text.trim())
    .filter(Boolean)
    .join("\n\n");
  if (!body && recoveredImages.length === 0)
    throw new Error(
      "No se encontró texto. Activa OCR para procesar PDFs escaneados.",
    );
  onProgress(83, "Organizando estructura…");
  let structuredText: string;
  let epubStructuredText: string;
  if (options.classifier) {
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
    const formattedBlocks = pageParts(structureText(body)).map((text, sourceIndex) => ({
      text,
      sourceIndex,
    }));
    structuredText = interleaveImages(formattedBlocks, recoveredImages);
    epubStructuredText = structuredText;
  }
  const markdownFilename = `${title}.md`;
  const epubFilename = `${title}.epub`;
  const markdownBlob = new Blob(
    [
      `---\ntitle: "${title.replaceAll('"', '\\"')}"\nsource: "${file.name}"\npages: ${document.numPages}\n---\n\n${structuredText}\n`,
    ],
    { type: "text/markdown;charset=utf-8" },
  );
  const epubBlob = await makeEpub(title, epubStructuredText, true, recoveredImages);
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
