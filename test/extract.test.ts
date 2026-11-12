import { describe, expect, it } from "vitest";
import { extractHtml } from "../src/extract/html.js";
import { extractPdf, PDF_LIMITS } from "../src/extract/pdf.js";
import { formatTimestamp, parseCdx } from "../src/tools/archive.js";
import { TtlCache } from "../src/cache.js";
import { loadConfig } from "../src/config.js";
import { HttpClient } from "../src/http/client.js";
import { BannedOnionList, md5 } from "../src/safety/banned.js";
import { SafetyGuard } from "../src/safety/guard.js";
import { isScholarlyHost } from "../src/safety/scholarly.js";
import { SafetyRefusal, type SearchDeps } from "../src/search.js";
import { archivedVersions } from "../src/tools/archive.js";
import { fetchPageContent, looksBinary, normalizeUserUrl, pageChannel } from "../src/tools/page.js";

describe("HTML extraction", () => {
  const html = `<!doctype html><html lang="pt-BR"><head>
      <title> Relatório   anual </title>
      <meta name="description" content="Resumo do relatório">
      <script>window.secret = "do not show";</script><style>.x{}</style>
    </head><body>
      <nav><a href="/home">Home</a> | <a href="/about">About</a></nav>
      <main>
        <h1>Main title</h1>
        <p>First paragraph with <a href="/doc.pdf">a PDF</a> and more   spacing.</p>
        <h2>Section</h2>
        <ul><li>One</li><li>Two</li></ul>
        <table><tr><td>A</td><td>B</td></tr></table>
        <pre>code  block</pre>
        <p>${"Long text. ".repeat(60)}</p>
        <img src="x.png" alt="ignored"><a href="javascript:alert(1)">bad</a><a href="mailto:a@b.c">mail</a>
        <a href="http://${"c".repeat(56)}.onion/forum">onion forum</a>
      </main>
      <footer>Footer text</footer>
    </body></html>`;

  const page = extractHtml(html, "https://site.example/reports/2024");

  it("reads metadata", () => {
    expect(page.title).toBe("Relatório anual");
    expect(page.description).toBe("Resumo do relatório");
    expect(page.language).toBe("pt-BR");
  });

  it("keeps structure from the main content and drops scripts, styles and chrome", () => {
    expect(page.text).toMatch(/^# Main title/);
    expect(page.text).toContain("## Section");
    expect(page.text).toContain("- One");
    expect(page.text).toContain("A | B");
    expect(page.text).toContain("```\ncode  block\n```");
    expect(page.text).toContain("First paragraph with a PDF and more spacing.");
    expect(page.text).not.toContain("do not show");
    expect(page.text).not.toContain("Footer text");
  });

  it("resolves links, skipping javascript: and mailto:", () => {
    const urls = page.links.map(l => l.url);
    expect(urls).toContain("https://site.example/home");
    expect(urls).toContain("https://site.example/doc.pdf");
    expect(urls).toContain(`http://${"c".repeat(56)}.onion/forum`);
    expect(urls.some(u => u.startsWith("javascript:") || u.startsWith("mailto:"))).toBe(false);
  });

  it("falls back to the body without navigation when there is no main element", () => {
    const simple = extractHtml(`<body><nav>Menu</nav><div>${"Body text. ".repeat(30)}</div><footer>Foot</footer></body>`, "https://a.example/");
    expect(simple.text).toContain("Body text.");
    expect(simple.text).not.toContain("Menu");
  });
});

describe("hostile HTML stays cheap (no catastrophic backtracking)", () => {
  it("handles a long row of table separators", () => {
    const start = performance.now();
    const page = extractHtml(`<p>${"| ".repeat(5000)}x</p>`, "https://a.example/");
    expect(page.text.endsWith("x")).toBe(true);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("handles a huge run of spaces inside <pre>", () => {
    const start = performance.now();
    extractHtml(`<pre>${" ".repeat(300_000)}x\n${" ".repeat(300_000)}</pre>`, "https://a.example/");
    expect(performance.now() - start).toBeLessThan(1500);
  });
});

/** Minimal valid PDF: `pages` pages sharing one content stream that shows `text`. */
function makePdf(pages: number, text = "Hello PDF"): Uint8Array {
  const content = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, i) => `${5 + i} 0 R`).join(" ")}] /Count ${pages} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  objects[4] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  for (let i = 0; i < pages; i++) {
    objects[5 + i] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 3 0 R >> >> >>";
  }
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let n = 1; n < objects.length; n++) {
    offsets[n] = out.length;
    out += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let n = 1; n < objects.length; n++) out += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

describe("PDF extraction in an isolated worker", () => {
  it("reads the text layer", async () => {
    const pdf = await extractPdf(makePdf(2));
    expect(pdf.pages).toBe(2);
    expect(pdf.pagesRead).toBe(2);
    expect(pdf.truncated).toBe(false);
    expect(pdf.text).toContain("Hello PDF");
  });

  it("stops at the page limit (many pages sharing one content stream)", async () => {
    const pdf = await extractPdf(makePdf(400), { ...PDF_LIMITS, maxPages: 50 });
    expect(pdf.pages).toBe(400);
    expect(pdf.pagesRead).toBe(50);
    expect(pdf.truncated).toBe(true);
  });

  it("stops at the character limit", async () => {
    const pdf = await extractPdf(makePdf(100), { ...PDF_LIMITS, maxChars: 50 });
    expect(pdf.text.length).toBeLessThanOrEqual(50);
    expect(pdf.truncated).toBe(true);
  });

  it("kills the worker when the hard time limit passes", async () => {
    await expect(extractPdf(makePdf(50), { ...PDF_LIMITS, timeoutMs: 1 })).rejects.toThrow(/longer than/);
  });

  it("rejects garbage without crashing the process", async () => {
    await expect(extractPdf(new TextEncoder().encode("%PDF-1.4 not really a pdf"))).rejects.toThrow();
  });
});

describe("URL normalization for page reading", () => {
  it("adds a scheme: https for the clear web, http for onions", () => {
    expect(normalizeUserUrl("example.com/a").toString()).toBe("https://example.com/a");
    expect(normalizeUserUrl(`${"d".repeat(56)}.onion`).toString()).toBe(`http://${"d".repeat(56)}.onion/`);
  });

  it("rewrites Wayback snapshots to their raw form", () => {
    expect(normalizeUserUrl("https://web.archive.org/web/20200101000000/https://example.com/").toString()).toBe(
      "https://web.archive.org/web/20200101000000id_/https://example.com/"
    );
    expect(normalizeUserUrl("https://web.archive.org/web/2020id_/https://example.com/").toString()).toBe("https://web.archive.org/web/2020id_/https://example.com/");
  });

  it("rejects garbage", () => {
    expect(() => normalizeUserUrl("http://")).toThrow();
  });

  it("treats tor2web gateways and archived onion pages as dark web", () => {
    const addr = "g".repeat(56);
    expect(pageChannel(new URL(`https://${addr}.onion.ly/`))).toBe("darkweb");
    expect(pageChannel(new URL(`https://web.archive.org/web/2020id_/http://${addr}.onion/`))).toBe("darkweb");
  });

  it("spots binary bodies", () => {
    expect(looksBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]))).toBe(true);
    expect(looksBinary(new TextEncoder().encode("plain text"))).toBe(false);
  });

  it("screens scholarly hosts with academic rules, onions as dark web, the rest as web", () => {
    expect(pageChannel(new URL("https://arxiv.org/pdf/1308.6768"))).toBe("academic");
    expect(pageChannel(new URL("https://www.scielo.br/j/x"))).toBe("academic");
    expect(pageChannel(new URL("https://pmc.ncbi.nlm.nih.gov/articles/1"))).toBe("academic");
    expect(pageChannel(new URL(`http://${"d".repeat(56)}.onion/`))).toBe("darkweb");
    expect(pageChannel(new URL("https://blog.example/"))).toBe("web");
    expect(isScholarlyHost("scielo.org.mx")).toBe(true);
    expect(isScholarlyHost("ve.scielo.org")).toBe(true);
    expect(isScholarlyHost("notarxiv.org")).toBe(false);
    expect(isScholarlyHost("arxiv.org.evil.example")).toBe(false);
    // A "scielo" label alone must not switch the strict rules off
    expect(isScholarlyHost("scielo.attacker.example")).toBe(false);
    expect(isScholarlyHost("scielo.203.0.113.7.nip.io")).toBe(false);
    // Open upload repositories are screened like the rest of the web
    expect(isScholarlyHost("zenodo.org")).toBe(false);
    expect(isScholarlyHost("osf.io")).toBe(false);
  });
});

describe("blacklist on every path to an onion service (no network needed: refused before any request)", () => {
  const banned = "h".repeat(56);
  const deps = (list?: BannedOnionList): SearchDeps => {
    const config = loadConfig({}).config;
    const http = new HttpClient(config);
    return { config, http, cache: new TtlCache<unknown>(1000), guard: new SafetyGuard(), banned: list ?? BannedOnionList.fromHashes(http, [md5(`${banned}.onion`)]) };
  };
  const page = (url: string) => ({ url, max_chars: 1000, start_char: 0, include_links: false });

  it("refuses a banned onion through a tor2web gateway or a Wayback copy", async () => {
    await expect(fetchPageContent(page(`https://${banned}.onion.ly/`), deps())).rejects.toBeInstanceOf(SafetyRefusal);
    await expect(fetchPageContent(page(`https://web.archive.org/web/2020/http://${banned}.onion/`), deps())).rejects.toBeInstanceOf(SafetyRefusal);
  });

  it("refuses to list archived captures of a banned onion", async () => {
    const input = { url: `${banned}.onion.ly/page`, match: "exact" as const, limit: 5, newest_first: true, only_successful: true };
    await expect(archivedVersions(input, deps())).rejects.toBeInstanceOf(SafetyRefusal);
  });

  it("fails closed when the blacklist cannot be loaded", async () => {
    const config = loadConfig({}).config;
    const unavailable = new BannedOnionList(new HttpClient(config), null);
    unavailable.ensure = async () => false;
    await expect(fetchPageContent(page(`https://${"j".repeat(56)}.onion.ly/`), deps(unavailable))).rejects.toThrow(/fail-closed/);
  });
});

describe("Wayback CDX", () => {
  it("parses rows and builds view/raw links", () => {
    const rows = [
      ["timestamp", "original", "mimetype", "statuscode", "length"],
      ["20200102030405", "https://example.com/", "text/html", "200", "1234"]
    ];
    const [snap] = parseCdx(rows);
    expect(snap).toMatchObject({
      date: "2020-01-02 03:04 UTC",
      original_url: "https://example.com/",
      status: "200",
      length: 1234,
      archive_url: "https://web.archive.org/web/20200102030405/https://example.com/",
      raw_url: "https://web.archive.org/web/20200102030405id_/https://example.com/"
    });
    expect(parseCdx([])).toEqual([]);
    expect(formatTimestamp("2019")).toBe("2019-01-01");
  });
});
