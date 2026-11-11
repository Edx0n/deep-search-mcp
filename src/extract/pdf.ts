import { extractText, getDocumentProxy } from "unpdf";

export interface ExtractedPdf {
  text: string;
  pages: number;
  title?: string;
}

/** Extracts the text layer of a PDF (scanned PDFs without OCR yield little or no text). */
export async function extractPdf(bytes: Uint8Array): Promise<ExtractedPdf> {
  // pdf.js may transfer the buffer, so hand it a copy
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text : [text];
  let title: string | undefined;
  try {
    const meta = (await pdf.getMetadata()) as { info?: { Title?: unknown } };
    if (typeof meta.info?.Title === "string" && meta.info.Title.trim()) title = meta.info.Title.trim();
  } catch {
    // Metadata is optional
  }
  const body = pages
    .map(p => p.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim())
    .filter(Boolean)
    .join("\n\n");
  return { text: body, pages: totalPages, title };
}
