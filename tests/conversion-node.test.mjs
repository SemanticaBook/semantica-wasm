import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { convertPdf, convertPdfPath } from "../dist/node.js";

function makePdf() {
  const stream = "BT /F1 18 Tf 72 720 Td (Semantica shared core) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, "ascii");
}

test("Node path adapter and web File adapter share PDF→Markdown/EPUB results", async () => {
  const directory = await mkdtemp(join(tmpdir(), "semantica-wasm-"));
  const input = join(directory, "shared-core.pdf");
  try {
    await writeFile(input, makePdf());
    const nodeResult = await convertPdfPath(input, "markdown", false);
    const webResult = await convertPdf(new File([makePdf()], "shared-core.pdf", { type: "application/pdf" }), "markdown", false, () => undefined);

    assert.equal(nodeResult.pages, 1);
    assert.match(await nodeResult.markdownBlob.text(), /Semantica shared core/);
    assert.equal(await nodeResult.markdownBlob.text(), await webResult.markdownBlob.text());
    assert.equal(nodeResult.markdownFilename, webResult.markdownFilename);
    assert.equal(nodeResult.epubFilename, webResult.epubFilename);

    const [nodeEpub, webEpub] = await Promise.all([
      JSZip.loadAsync(await nodeResult.epubBlob.arrayBuffer()),
      JSZip.loadAsync(await webResult.epubBlob.arrayBuffer()),
    ]);
    assert.equal(await nodeEpub.file("OEBPS/chapter.xhtml").async("string"), await webEpub.file("OEBPS/chapter.xhtml").async("string"));
    assert.ok(nodeEpub.file("OEBPS/content.opf"));
    assert.ok(nodeEpub.file("OEBPS/nav.xhtml"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
