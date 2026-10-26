export type BookMetadata = {
  title: string;
  authors: string[];
  publisher?: string;
  publishedDate?: string;
  language?: string;
  description?: string;
  isbn?: string;
};

export type CoverAsset = {
  url?: string;
  dataUrl?: string;
  path?: string;
  mimeType?: string;
};

export type BookCoverCandidate = {
  id: string;
  source: "openlibrary" | "googlebooks";
  coverUrl: string;
  metadata: BookMetadata;
};

export type CoverSelectionRequest = {
  query: string;
  initialMetadata: BookMetadata;
  candidates: BookCoverCandidate[];
  originalCoverDataUrl?: string;
};

export type CoverSelection = {
  metadata: BookMetadata;
  cover?: CoverAsset | null;
  automatic?: boolean;
};

export type BookMetadataOptions = {
  mode: "auto" | "manual";
  metadata?: Partial<BookMetadata>;
  cover?: CoverAsset | null;
  googleBooksApiKey?: string;
};

type OpenLibraryDoc = {
  key?: string;
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  cover_i?: number;
  isbn?: string[];
  publisher?: string[];
  language?: string[];
  description?: string | { value?: string };
};
type GoogleBooksItem = {
  id?: string;
  volumeInfo?: {
    title?: string;
    authors?: string[];
    publisher?: string;
    publishedDate?: string;
    description?: string;
    language?: string;
    industryIdentifiers?: { identifier?: string }[];
    imageLinks?: { extraLarge?: string; large?: string; thumbnail?: string; smallThumbnail?: string };
  };
};

function normalize(value: string) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function titleSimilarity(query: string, result: string) {
  const left = normalize(query);
  const right = normalize(result);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (right.startsWith(left) || left.startsWith(right)) return 0.82;
  const terms = new Set(left.split(" "));
  const matches = right.split(" ").filter((word) => terms.has(word)).length;
  return matches / Math.max(terms.size, 1);
}

export async function searchBookMetadata(
  query: string,
  options: { googleBooksApiKey?: string; signal?: AbortSignal } = {},
): Promise<BookCoverCandidate[]> {
  const title = query.trim();
  if (!title) return [];
  const openLibraryUrl = new URL("https://openlibrary.org/search.json");
  openLibraryUrl.search = new URLSearchParams({
    title,
    fields: "key,title,author_name,first_publish_year,cover_i,isbn,publisher,language,description",
    limit: "12",
  }).toString();
  const requests: Promise<BookCoverCandidate[]>[] = [
    fetch(openLibraryUrl, { signal: options.signal ?? AbortSignal.timeout(10_000) })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Open Library respondió ${response.status}`);
        const payload = await response.json() as { docs?: OpenLibraryDoc[] };
        return (payload.docs ?? []).flatMap((book): BookCoverCandidate[] => {
          if (!book.title || !book.cover_i) return [];
          return [{
            id: `openlibrary:${book.key ?? book.cover_i}`,
            source: "openlibrary",
            coverUrl: `https://covers.openlibrary.org/b/id/${book.cover_i}-L.jpg`,
            metadata: {
              title: book.title,
              authors: book.author_name ?? [],
              publisher: book.publisher?.[0],
              publishedDate: book.first_publish_year ? String(book.first_publish_year) : undefined,
              language: book.language?.[0],
              description: typeof book.description === "string" ? book.description : book.description?.value,
              isbn: book.isbn?.[0],
            },
          }];
        });
      })
      .catch(() => []),
  ];
  if (options.googleBooksApiKey) {
    const googleUrl = new URL("https://www.googleapis.com/books/v1/volumes");
    googleUrl.search = new URLSearchParams({ q: `intitle:${title}`, maxResults: "12", key: options.googleBooksApiKey }).toString();
    requests.push(fetch(googleUrl, { signal: options.signal ?? AbortSignal.timeout(10_000) })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Google Books respondió ${response.status}`);
        const payload = await response.json() as { items?: GoogleBooksItem[] };
        return (payload.items ?? []).flatMap((item): BookCoverCandidate[] => {
          const book = item.volumeInfo;
          const coverUrl = book?.imageLinks?.extraLarge ?? book?.imageLinks?.large ?? book?.imageLinks?.thumbnail ?? book?.imageLinks?.smallThumbnail;
          if (!book?.title || !coverUrl) return [];
          return [{
            id: `googlebooks:${item.id ?? book.title}`,
            source: "googlebooks",
            coverUrl: coverUrl.replace(/^http:/, "https:"),
            metadata: {
              title: book.title,
              authors: book.authors ?? [],
              publisher: book.publisher,
              publishedDate: book.publishedDate,
              language: book.language,
              description: book.description,
              isbn: book.industryIdentifiers?.[0]?.identifier,
            },
          }];
        });
      })
      .catch(() => []));
  }
  const results = (await Promise.all(requests)).flat()
    .map((candidate) => ({ candidate, score: titleSimilarity(title, candidate.metadata.title) }))
    .filter(({ score }) => score >= 0.35)
    .sort((left, right) => right.score - left.score)
    .map(({ candidate }) => candidate);
  const seen = new Set<string>();
  return results.filter((candidate) => {
    const key = `${normalize(candidate.metadata.title)}|${normalize(candidate.metadata.authors.join(" "))}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 3);
}

export async function loadCoverAsset(cover: CoverAsset): Promise<{ bytes: Uint8Array; mimeType: string }> {
  if (cover.dataUrl) {
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(cover.dataUrl);
    if (!match) throw new Error("La portada manual no tiene un Data URL válido.");
    const mimeType = cover.mimeType ?? match[1] ?? "image/jpeg";
    if (!/^image\/(jpeg|png)$/i.test(mimeType)) throw new Error("La portada debe ser JPEG o PNG para incluirla en el EPUB.");
    const bytes = match[2]
      ? Uint8Array.from(atob(match[3]), (character) => character.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(match[3]));
    return { bytes, mimeType };
  }
  if (!cover.url) throw new Error("La portada requiere una URL o una imagen cargada.");
  const response = await fetch(cover.url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`No se pudo descargar la portada (${response.status}).`);
  const mimeType = cover.mimeType ?? response.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
  if (!/^image\/(jpeg|png)$/i.test(mimeType)) throw new Error("La portada remota debe ser JPEG o PNG para incluirla en el EPUB.");
  return { bytes: new Uint8Array(await response.arrayBuffer()), mimeType };
}

export function mergeBookMetadata(base: BookMetadata, overrides: Partial<BookMetadata> = {}): BookMetadata {
  return {
    ...base,
    ...overrides,
    title: overrides.title?.trim() || base.title,
    authors: overrides.authors ?? base.authors,
  };
}
