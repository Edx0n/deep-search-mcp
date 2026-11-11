import { describe, expect, it } from "vitest";
import { extractHtml } from "../src/extract/html.js";
import { formatTimestamp, parseCdx } from "../src/tools/archive.js";
import { isScholarlyHost } from "../src/safety/scholarly.js";
import { normalizeUserUrl, pageChannel } from "../src/tools/page.js";

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

  it("screens scholarly hosts with academic rules, onions as dark web, the rest as web", () => {
    expect(pageChannel(new URL("https://arxiv.org/pdf/1308.6768"))).toBe("academic");
    expect(pageChannel(new URL("https://www.scielo.br/j/x"))).toBe("academic");
    expect(pageChannel(new URL("https://pmc.ncbi.nlm.nih.gov/articles/1"))).toBe("academic");
    expect(pageChannel(new URL(`http://${"d".repeat(56)}.onion/`))).toBe("darkweb");
    expect(pageChannel(new URL("https://blog.example/"))).toBe("web");
    expect(isScholarlyHost("scielo.org.mx")).toBe(true);
    expect(isScholarlyHost("notarxiv.org")).toBe(false);
    expect(isScholarlyHost("arxiv.org.evil.example")).toBe(false);
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
