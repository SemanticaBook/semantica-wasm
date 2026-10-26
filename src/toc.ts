export type TocCandidateBlock = {
  text: string;
  label: string;
  confidence: number;
  sourceIndex?: number;
  anchorId?: string;
  targetId?: string;
  isTocEntry?: boolean;
};

const INDEX_HEADING = /^(?:índice(?:\s+(?:general|alfab[eé]tico|onom[aá]stico|anal[ií]tico|tem[aá]tico))?|indice(?:\s+(?:general|alfab[eé]tico|onom[aá]stico|anal[ií]tico|tem[aá]tico))?|contenido|tabla\s+de\s+contenido(?:s)?|sumario|table of contents|contents)\s*[:.]?$/iu;
const ENTRY_START = /\b(?:cap[ií1]tulo|capimlo|pr[oó]logo|ep[ií]logo|ap[eé]ndice|anexo|introducci[oó]n|conclusi[oó]n|mapa\s+del\s+viaje)\b/giu;
const ENTRY_PREFIX = /^(?:cap[ií1]tulo|capimlo|pr[oó]logo|ep[ií]logo|ap[eé]ndice|anexo|introducci[oó]n|conclusi[oó]n|mapa\s+del\s+viaje)\b/iu;
const PAGE_REFERENCE = /(?:\.{2,}|…+|·{2,}|_{2,}|[-–—]{2,})/u;
const COMMON = new Set("el la los las de del y en a al un una unos unas por para con sin que su sus este esta lo las los como la capítulo capitulo prólogo epilogo apéndice anexo mapa viaje".split(/\s+/));

export function isIndexHeading(text: string) {
  return INDEX_HEADING.test(text.trim().replace(/\s+\d{1,3}\s*$/, "").replace(/[:.]+$/, ""));
}

/** Split an OCR-flattened index block at repeated entry headings. */
export function expandIndexBlocks(text: string) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!/^(?:índice|indice|contenido|tabla\s+de\s+contenido|sumario|table of contents|contents)\b/iu.test(clean)) return [text.trim()];
  const markers = [...clean.matchAll(ENTRY_START)];
  if (markers.length < 2) return [text.trim()];
  const result: string[] = [];
  const prefix = clean.slice(0, markers[0].index).replace(/[\s:.,-]+$/g, "").trim();
  if (prefix) result.push(prefix);
  markers.forEach((marker, index) => {
    const start = marker.index ?? 0;
    const end = markers[index + 1]?.index ?? clean.length;
    const entry = clean.slice(start, end).trim();
    if (entry) result.push(entry);
  });
  return result.length > 1 ? result : [text.trim()];
}

function hasPageReference(text: string) {
  return PAGE_REFERENCE.test(text) || /\s\d{1,3}\s*$/u.test(text);
}

function isEntry(text: string) {
  return ENTRY_PREFIX.test(text.trim()) || hasPageReference(text);
}

export function findIndexEntryIndexes(blocks: string[]) {
  const indexes = new Set<number>();
  for (let heading = 0; heading < blocks.length; heading += 1) {
    if (!isIndexHeading(blocks[heading])) continue;
    const entries: number[] = [];
    for (let index = heading + 1; index < blocks.length && entries.length < 50; index += 1) {
      const text = blocks[index].trim();
      if (!isEntry(text)) break;
      // A chapter heading followed by ordinary prose is the start of the book,
      // not another index row. Keep the row before it as the final TOC entry.
      if (
        entries.length > 0 && ENTRY_PREFIX.test(text) && !hasPageReference(text) &&
        !isEntry(blocks[index + 1] ?? "")
      ) break;
      entries.push(index);
    }
    if (entries.length >= 2) entries.forEach((index) => indexes.add(index));
    heading = entries.at(-1) ?? heading;
  }
  return indexes;
}

function cleanEntry(text: string) {
  return text
    .replace(/(?:\.{2,}|…+|·{2,}|_{2,}|[-–—]{2,})[\s\S]*$/u, "")
    .replace(/\s+\d{1,3}\s*$/u, "")
    .replace(/[.·_]{2,}/g, " ")
    .replace(/\bcapimlo\b/giu, "Capítulo")
    .replace(/\bcap[ií1]tulo\b/giu, "Capítulo")
    .replace(/^(Capítulo\s+)ILL(?=\s*[:.])/iu, "$1III")
    .replace(/^(Capítulo\s+)Y(?=\s*[:.])/iu, "$1V")
    .replace(/\s+/g, " ")
    .replace(/[\s:.,;—–-]+$/g, "")
    .trim();
}

function chapterReference(text: string) {
  const match = /^(?:cap[ií1]tulo|capimlo)\s+([ivxlcdmy1|]+)/iu.exec(cleanEntry(text));
  if (!match) return null;
  let roman = match[1].toLocaleUpperCase("es").replace(/1|\|/g, "I");
  if (roman === "Y") roman = "V";
  if (roman === "ILL" || roman === "IL") roman = "III";
  return roman;
}

function headingTokens(text: string) {
  const normalized = cleanEntry(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es")
    .replace(/^(?:capitulo|parte|libro|unidad)\s+[\w.-]+\s*/u, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ");
  return new Set(normalized.split(/\s+/).filter((token) => token.length > 1 && !COMMON.has(token)));
}

function similarity(left: string, right: string) {
  const a = headingTokens(left);
  const b = headingTokens(right);
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return (2 * intersection) / (a.size + b.size);
}

function slug(text: string) {
  return cleanEntry(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "seccion";
}

export function linkTableOfContents<T extends TocCandidateBlock>(items: T[]): T[] {
  const result = items.map((item) => ({ ...item }));
  const indexes = findIndexEntryIndexes(result.map((item) => item.text));
  if (!indexes.size) return result;

  const entryIndexes = [...indexes].sort((a, b) => a - b);
  const firstEntry = entryIndexes[0];
  const lastEntry = entryIndexes.at(-1)!;
  const headingIndexes = result
    .map((item, index) => ({ item, index }))
    .filter(({ item, index }) =>
      (index < firstEntry || index > lastEntry) &&
      (item.label === "heading" || item.label === "subheading" || item.label === "title" ||
        /^(?:cap[ií1]tulo|capimlo|parte|libro|unidad)\b/iu.test(item.text.trim())),
    );
  const assigned = new Map<number, string>();

  for (const entryIndex of entryIndexes) {
    const entry = result[entryIndex];
    const chapter = chapterReference(entry.text);
    const directChapter = chapter && headingIndexes.find(({ item }) => chapterReference(item.text) === chapter);
    const best = directChapter
      ? { ...directChapter, score: 1 }
      : headingIndexes
      .map(({ item, index }) => ({ item, index, score: similarity(entry.text, item.text) }))
      .sort((a, b) => b.score - a.score)[0];
    let targetId: string | undefined;
    if (best && best.score >= 0.55) {
      targetId = assigned.get(best.index);
      if (!targetId) {
        targetId = `sem-${best.index + 1}-${slug(best.item.text)}`;
        assigned.set(best.index, targetId);
      }
      best.item.anchorId = targetId;
    }
    entry.text = cleanEntry(entry.text);
    entry.label = "list_item";
    entry.isTocEntry = true;
    if (targetId) entry.targetId = targetId;
  }
  return result;
}
