import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

export interface ExtractedPdf {
  text: string;
  /** Pages in the document. */
  pages: number;
  /** Pages actually read (fewer when a limit was hit). */
  pagesRead: number;
  /** True when a page, character or time limit cut the extraction short. */
  truncated: boolean;
  title?: string;
}

export interface PdfLimits {
  maxPages: number;
  maxChars: number;
  /** Soft budget checked between pages. */
  budgetMs: number;
  /** Hard limit: the worker is terminated after this long. */
  timeoutMs: number;
  /** Heap limit of the worker; exceeding it kills the worker, never the server. */
  maxHeapMb: number;
}

export const PDF_LIMITS: PdfLimits = {
  maxPages: 300,
  maxChars: 2_000_000,
  budgetMs: 20_000,
  timeoutMs: 30_000,
  maxHeapMb: 512
};

/**
 * Worker body (CommonJS, evaluated in a worker thread). pdf.js runs here so that a hostile PDF
 * (thousands of pages, decompression bombs, pathological content streams) can only exhaust this
 * thread's own CPU and heap budget.
 */
function workerSource(unpdfPath: string): string {
  return `
// stdout carries the MCP protocol: anything pdf.js prints must go to stderr instead
console.log = console.info = console.warn = console.debug = console.error;
const { parentPort, workerData } = require("node:worker_threads");
const { getDocumentProxy } = require(${JSON.stringify(unpdfPath)});
(async () => {
  const { bytes, maxPages, maxChars, budgetMs } = workerData;
  const started = Date.now();
  // Only the text layer is needed: no font faces, no system fonts, no XFA forms; errors-only logging.
  const pdf = await getDocumentProxy(new Uint8Array(bytes), { disableFontFace: true, useSystemFonts: false, enableXfa: false, verbosity: 0 });
  const total = pdf.numPages;
  const parts = [];
  let chars = 0;
  let read = 0;
  let truncated = false;
  for (let i = 1; i <= total; i++) {
    if (i > maxPages || chars >= maxChars || Date.now() - started > budgetMs) { truncated = true; break; }
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    let text = "";
    for (const item of content.items) {
      if (typeof item.str === "string") text += item.str + (item.hasEOL ? "\\n" : "");
      if (chars + text.length > maxChars) break;
    }
    page.cleanup();
    text = text.split("\\n").map(line => line.trimEnd()).join("\\n").replace(/\\n{3,}/g, "\\n\\n").trim();
    if (text) {
      const separator = parts.length > 0 ? 2 : 0; // pages are joined with a blank line
      const room = maxChars - chars - separator;
      if (room <= 0) { truncated = true; break; }
      if (text.length > room) { text = text.slice(0, room); truncated = true; }
      parts.push(text);
      chars += text.length + separator;
    }
    read = i;
  }
  let title;
  try {
    const meta = await pdf.getMetadata();
    if (meta && meta.info && typeof meta.info.Title === "string" && meta.info.Title.trim()) title = meta.info.Title.trim();
  } catch {}
  parentPort.postMessage({ ok: true, text: parts.join("\\n\\n"), pages: total, pagesRead: read, truncated, title });
})().catch(error => parentPort.postMessage({ ok: false, error: String((error && error.message) || error) }));
`;
}

let source: string | undefined;

/** Extracts the text layer of a PDF in an isolated, resource-limited worker thread. */
export function extractPdf(bytes: Uint8Array, limits: PdfLimits = PDF_LIMITS): Promise<ExtractedPdf> {
  source ??= workerSource(createRequire(import.meta.url).resolve("unpdf"));
  return new Promise<ExtractedPdf>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };
    const worker = new Worker(source!, {
      eval: true,
      workerData: { bytes, maxPages: limits.maxPages, maxChars: limits.maxChars, budgetMs: limits.budgetMs },
      resourceLimits: { maxOldGenerationSizeMb: limits.maxHeapMb, maxYoungGenerationSizeMb: 64 }
    });
    const timer = setTimeout(
      () => finish(() => reject(new Error(`it took longer than ${Math.round(limits.timeoutMs / 1000)}s to process`))),
      limits.timeoutMs
    );
    worker.once("message", (message: { ok: boolean; error?: string } & Partial<ExtractedPdf>) => {
      finish(() =>
        message.ok
          ? resolve({
              text: message.text ?? "",
              pages: message.pages ?? 0,
              pagesRead: message.pagesRead ?? 0,
              truncated: Boolean(message.truncated),
              ...(message.title ? { title: message.title } : {})
            })
          : reject(new Error(message.error ?? "unknown PDF error"))
      );
    });
    worker.once("error", (error: Error & { code?: string }) => {
      finish(() =>
        reject(error.code === "ERR_WORKER_OUT_OF_MEMORY" ? new Error(`it needs more than ${limits.maxHeapMb} MB of memory`) : error)
      );
    });
    worker.once("exit", code => {
      finish(() => reject(new Error(`the PDF reader stopped unexpectedly (exit code ${code})`)));
    });
  });
}
