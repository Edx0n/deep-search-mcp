import { describe, expect, it } from "vitest";
import { arxivQuery, parseArxiv } from "../src/sources/academic/arxiv.js";
import { parseBdtd } from "../src/sources/academic/bdtd.js";
import { parseCore } from "../src/sources/academic/core.js";
import { parseCrossref } from "../src/sources/academic/crossref.js";
import { parseDoaj } from "../src/sources/academic/doaj.js";
import { parseEuropePmc } from "../src/sources/academic/europepmc.js";
import { parseOpenAlex, rebuildAbstract } from "../src/sources/academic/openalex.js";
import { parseSemanticScholar } from "../src/sources/academic/semanticscholar.js";
import { parseInternetArchive } from "../src/sources/archive.js";
import { authorsList, pageWindow, SerialQueue } from "../src/sources/common.js";
import { ahmiaBase, parseAhmiaResults, parseAhmiaToken } from "../src/sources/darkweb.js";
import { parseDatacite, parseZenodo } from "../src/sources/data.js";
import { SOURCES } from "../src/sources/registry.js";
import { isDuckDuckGoChallenge, parseBrave, parseDuckDuckGo, parseMarginalia, parseWiby, unwrapDuckDuckGoLink } from "../src/sources/web.js";
import { loadConfig } from "../src/config.js";
import { SOURCE_IDS } from "../src/types.js";
import { cleanDoi, decodeEntities, dedupeKey, sanitizeLucene, stripTags } from "../src/util/text.js";

const ONION = "a".repeat(56) + ".onion";

describe("helpers", () => {
  it("maps offset/limit onto pages", () => {
    expect(pageWindow(0, 5)).toEqual({ page: 1, perPage: 5, skip: 0 });
    expect(pageWindow(10, 5)).toEqual({ page: 3, perPage: 5, skip: 0 });
    expect(pageWindow(3, 5)).toEqual({ page: 1, perPage: 8, skip: 3 });
    expect(pageWindow(203, 5, 100)).toEqual({ page: 41, perPage: 5, skip: 0 });
  });

  it("sanitizes Lucene queries", () => {
    expect(sanitizeLucene('covid: "long term" (effects) -x')).toBe('covid "long term" effects x');
    expect(sanitizeLucene('odd "quote')).toBe("odd quote");
    expect(sanitizeLucene("anti-inflammatory drugs")).toBe("anti-inflammatory drugs");
  });

  it("cleans DOIs and builds de-duplication keys", () => {
    expect(cleanDoi("https://doi.org/10.1234/ABC.5")).toBe("10.1234/ABC.5");
    expect(cleanDoi("not a doi")).toBeUndefined();
    expect(dedupeKey("https://x.org/a", "10.1/X")).toBe("doi:10.1/x");
    expect(dedupeKey("https://www.Example.org/page/?utm_source=a&id=2")).toBe("url:example.org/page?id=2");
  });

  it("strips JATS markup and entities", () => {
    expect(stripTags("<jats:p>Caf&eacute; &amp; <b>bar</b> &#233;</jats:p>")).toBe("Café & bar é");
  });

  it("decodes every named HTML entity once, keeping case, and leaves unknown or unterminated ones alone", () => {
    expect(decodeEntities("Ucr&acirc;nia, R&uacute;ssia, &Aacute;frica, cora&ccedil;&atilde;o, &alpha; &le; 2")).toBe("Ucrânia, Rússia, África, coração, α ≤ 2");
    expect(decodeEntities("&notanentity; R&D &copy 2026 &amp;acirc;")).toBe("&notanentity; R&D &copy 2026 &acirc;");
    expect(decodeEntities("hy&shy;phen")).toBe("hyphen");
  });

  it("strips tags in linear time on hostile descriptions", () => {
    const start = performance.now();
    stripTags("<".repeat(200_000));
    stripTags("<script".repeat(50_000));
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("de-duplicates author names written in different orders", () => {
    expect(authorsList(["Liliana Pena Naval", "Naval, Liliana Pena", "José Souza", "Souza, José", " "])).toEqual(["Liliana Pena Naval", "José Souza"]);
  });

  it("serializes tasks with a gap", async () => {
    const queue = new SerialQueue(30);
    const starts: number[] = [];
    const task = async () => {
      starts.push(Date.now());
      await new Promise(r => setTimeout(r, 5));
    };
    await Promise.all([queue.run(task), queue.run(task)]);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(30);
  });
});

describe("registry", () => {
  it("registers every declared source id exactly once", () => {
    expect(SOURCES.map(s => s.id).sort()).toEqual([...SOURCE_IDS].sort());
  });

  it("runs keyless sources by default and keeps key-only ones opt-in", () => {
    const config = loadConfig({}).config;
    const defaults = SOURCES.filter(s => s.isDefault(config)).map(s => s.id);
    expect(defaults).toContain("openalex");
    expect(defaults).toContain("ahmia");
    expect(defaults).not.toContain("semantic_scholar");
    expect(defaults).not.toContain("brave");
    const withKeys = loadConfig({ SEMANTIC_SCHOLAR_API_KEY: "k", BRAVE_API_KEY: "k" }).config;
    expect(SOURCES.filter(s => s.isDefault(withKeys)).map(s => s.id)).toEqual(expect.arrayContaining(["semantic_scholar", "brave"]));
  });
});

describe("academic parsers", () => {
  it("OpenAlex: rebuilds abstracts and prefers DOI links", () => {
    expect(rebuildAbstract({ world: [1], Hello: [0] })).toBe("Hello world");
    const page = parseOpenAlex({
      meta: { count: 42 },
      results: [
        {
          id: "https://openalex.org/W1",
          doi: "https://doi.org/10.1234/abc",
          display_name: "A Study",
          publication_year: 2020,
          authorships: [{ author: { display_name: "Ana Silva" } }],
          primary_location: { source: { display_name: "Journal X" }, landing_page_url: "https://journal.example/a" },
          open_access: { is_oa: true, oa_url: "https://repo.example/a.pdf" },
          cited_by_count: 7,
          abstract_inverted_index: { Short: [0], abstract: [1] }
        }
      ]
    });
    expect(page.total).toBe(42);
    expect(page.results[0]).toMatchObject({
      source: "openalex",
      title: "A Study",
      url: "https://doi.org/10.1234/abc",
      doi: "10.1234/abc",
      snippet: "Short abstract",
      authors: ["Ana Silva"],
      venue: "Journal X",
      pdf_url: "https://repo.example/a.pdf",
      open_access: true,
      citations: 7,
      year: 2020
    });
  });

  it("Crossref/SciELO: strips JATS abstracts and tags the source", () => {
    const page = parseCrossref(
      {
        message: {
          "total-results": 1,
          items: [
            {
              DOI: "10.1590/xyz",
              title: ["Título <i>em</i> português"],
              author: [{ given: "João", family: "Souza" }],
              "container-title": ["Revista Y"],
              issued: { "date-parts": [[2019, 5]] },
              abstract: "<jats:p>Abstract Resumo do estudo.</jats:p>"
            }
          ]
        }
      },
      "scielo"
    );
    expect(page.results[0]).toMatchObject({
      source: "scielo",
      title: "Título em português",
      url: "https://doi.org/10.1590/xyz",
      authors: ["João Souza"],
      year: 2019,
      snippet: "Resumo do estudo."
    });
  });

  it("Europe PMC: links PMC full text and free PDFs", () => {
    const page = parseEuropePmc({
      hitCount: 3,
      resultList: {
        result: [
          {
            id: "123",
            source: "MED",
            pmcid: "PMC999",
            title: "Trial results.",
            authorString: "Lee A, Kim B.",
            pubYear: "2021",
            isOpenAccess: "Y",
            fullTextUrlList: { fullTextUrl: [{ availabilityCode: "OA", documentStyle: "pdf", url: "https://europepmc.org/pdf.pdf" }] }
          }
        ]
      }
    });
    expect(page.results[0]).toMatchObject({
      title: "Trial results",
      url: "https://europepmc.org/article/PMC/PMC999",
      authors: ["Lee A", "Kim B"],
      pdf_url: "https://europepmc.org/pdf.pdf",
      open_access: true,
      year: 2021
    });
  });

  it("arXiv: builds AND queries and parses Atom entries", () => {
    expect(arxivQuery("tor hidden services")).toBe("all:tor AND all:hidden AND all:services");
    expect(arxivQuery("x", 2020, 2021)).toBe("all:x AND submittedDate:[202001010000 TO 202112312359]");
    const xml = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom">
        <opensearch:totalResults>2</opensearch:totalResults>
        <entry>
          <id>http://arxiv.org/abs/1234.5678v1</id>
          <title>  A   paper
            title </title>
          <summary>Summary text.</summary>
          <published>2014-02-03T00:00:00Z</published>
          <author><name>Alice</name></author>
          <author><name>Bob</name></author>
          <link href="http://arxiv.org/abs/1234.5678v1" rel="alternate" type="text/html"/>
          <link href="http://arxiv.org/pdf/1234.5678v1" rel="related" type="application/pdf" title="pdf"/>
          <arxiv:primary_category term="cs.CR"/>
        </entry>
        <entry>
          <id>http://arxiv.org/abs/2222.0001v2</id>
          <title>1984</title>
          <published>2022-01-01T00:00:00Z</published>
          <author><name>Carol</name></author>
          <link href="http://arxiv.org/abs/2222.0001v2" rel="alternate" type="text/html"/>
        </entry>
      </feed>`;
    const page = parseArxiv(xml);
    expect(page.total).toBe(2);
    expect(page.results[0]).toMatchObject({
      title: "A paper title",
      url: "https://arxiv.org/abs/1234.5678v1",
      pdf_url: "https://arxiv.org/pdf/1234.5678v1",
      authors: ["Alice", "Bob"],
      venue: "arXiv cs.CR",
      year: 2014
    });
    expect(page.results[1]?.title).toBe("1984");
  });

  it("DOAJ, CORE, Semantic Scholar and BDTD", () => {
    const doaj = parseDoaj({
      total: 1,
      results: [
        {
          id: "abc",
          bibjson: {
            title: "Open article",
            year: "2018",
            journal: { title: "Open Journal", language: ["PT"] },
            author: [{ name: "Maria" }],
            link: [{ type: "fulltext", url: "https://oj.example/1" }],
            identifier: [{ type: "doi", id: "10.5555/oa" }]
          }
        }
      ]
    });
    expect(doaj.results[0]).toMatchObject({ url: "https://oj.example/1", doi: "10.5555/oa", venue: "Open Journal", open_access: true });

    const core = parseCore({
      totalHits: 9,
      results: [{ id: 77, title: "Repo paper", downloadUrl: "https://core.ac.uk/download/1.pdf", yearPublished: 2011, authors: [{ name: "X" }] }]
    });
    expect(core.results[0]).toMatchObject({ url: "https://core.ac.uk/works/77", pdf_url: "https://core.ac.uk/download/1.pdf", year: 2011 });

    const s2 = parseSemanticScholar({
      total: 1,
      data: [{ paperId: "p1", title: "S2 paper", year: 2020, openAccessPdf: { url: "https://x/p.pdf" }, externalIds: { DOI: "10.1234/z" }, citationCount: 3 }]
    });
    expect(s2.results[0]).toMatchObject({ url: "https://www.semanticscholar.org/paper/p1", doi: "10.1234/z", pdf_url: "https://x/p.pdf" });

    const bdtd = parseBdtd({
      resultCount: 2,
      records: [
        { id: "UFX_1", title: "Dissertação sobre dengue", primaryAuthors: ["Silva, Ana"], formats: ["masterThesis"], publicationDates: ["2017"], urls: [{ url: "https://repo.example/1" }] },
        { id: "UFX_2", primaryAuthors: ["No Title"] }
      ]
    });
    expect(bdtd.results).toHaveLength(1);
    expect(bdtd.results[0]).toMatchObject({ type: "master's thesis", year: 2017, url: "https://repo.example/1", authors: ["Silva, Ana"] });
  });
});

describe("data and archive parsers", () => {
  it("DataCite, Zenodo and Internet Archive", () => {
    const dc = parseDatacite({
      meta: { total: 5 },
      data: [{ id: "10.5281/zenodo.1", attributes: { doi: "10.5281/zenodo.1", titles: [{ title: "Dataset" }], publicationYear: 2022, publisher: { name: "Zenodo" }, types: { resourceTypeGeneral: "Dataset" } } }]
    });
    expect(dc.results[0]).toMatchObject({ url: "https://doi.org/10.5281/zenodo.1", venue: "Zenodo", type: "dataset", year: 2022 });

    const zen = parseZenodo({
      hits: { total: 1, hits: [{ id: 5, doi: "10.5281/zenodo.5", links: { self_html: "https://zenodo.org/records/5" }, metadata: { title: "Code", publication_date: "2021-03-04", description: "<p>Desc</p>", resource_type: { title: "Software" }, access_right: "open" } }] }
    });
    expect(zen.results[0]).toMatchObject({ url: "https://zenodo.org/records/5", snippet: "Desc", type: "software", open_access: true, year: 2021 });

    const ia = parseInternetArchive({
      response: { numFound: 1, docs: [{ identifier: "old-report", title: "Old report", description: ["Part 1", "Part 2"], mediatype: "texts", year: "1999", creator: "Agency" }] }
    });
    expect(ia.results[0]).toMatchObject({ url: "https://archive.org/details/old-report", snippet: "Part 1 Part 2", type: "texts", year: 1999, authors: ["Agency"] });
  });

  it("decodes the accents Zenodo sends as named HTML entities", () => {
    const zen = parseZenodo({
      hits: { total: 1, hits: [{ id: 7, links: { self_html: "https://zenodo.org/records/7" }, metadata: { title: "Viola&ccedil;&otilde;es do direito humanit&aacute;rio", description: "<p>Relat&oacute;rio sobre a guerra na Ucr&acirc;nia e a situa&ccedil;&atilde;o humanit&aacute;ria.</p>" } }] }
    });
    expect(zen.results[0]).toMatchObject({ title: "Violações do direito humanitário", snippet: "Relatório sobre a guerra na Ucrânia e a situação humanitária." });
  });
});

describe("web parsers", () => {
  it("Marginalia, Wiby and Brave", () => {
    const m = parseMarginalia({ page: 1, pages: 3, results: [{ url: "https://small.example/", title: "Small site", description: "Notes", format: "html" }] });
    expect(m.hasMore).toBe(true);
    expect(m.results[0]).toMatchObject({ source: "marginalia", url: "https://small.example/", snippet: "Notes" });

    const w = parseWiby([{ URL: "http://old.example/", Title: "Old &amp; gold", Snippet: " text " }]);
    expect(w.results[0]).toMatchObject({ title: "Old & gold", snippet: "text" });

    const b = parseBrave({ query: { more_results_available: true }, web: { results: [{ title: "<strong>Bold</strong> title", url: "https://b.example/", description: "a <strong>b</strong>" }] } });
    expect(b.results[0]).toMatchObject({ title: "Bold title", snippet: "a b" });
  });

  it("DuckDuckGo: skips ads, unwraps redirect links and detects bot checks", () => {
    const html = `
      <div class="result results_links result--ad"><a class="result__a" href="https://ad.example/">Ad</a></div>
      <div class="result results_links"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Freal.example%2Fpage&rut=x">Real <b>page</b></a>
        <a class="result__snippet">Snippet <b>text</b></a></div>
      <div class="result"><a class="result__a" href="https://direct.example/">Direct</a></div>`;
    const page = parseDuckDuckGo(html);
    expect(page.results.map(r => r.url)).toEqual(["https://real.example/page", "https://direct.example/"]);
    expect(page.results[0]).toMatchObject({ title: "Real page", snippet: "Snippet text" });
    expect(unwrapDuckDuckGoLink("https://x.example/a")).toBe("https://x.example/a");
    expect(isDuckDuckGoChallenge('<div class="anomaly-modal">')).toBe(true);
    expect(isDuckDuckGoChallenge(html)).toBe(false);
  });
});

describe("Ahmia (dark web)", () => {
  it("reads the hidden session token of the search form", () => {
    const html = `<form id="searchForm" action="/search/"><input name="q"><input type="hidden" name="fb3586" value="ba3f4d"></form>`;
    expect(parseAhmiaToken(html)).toEqual({ name: "fb3586", value: "ba3f4d" });
    expect(parseAhmiaToken("<form></form>")).toBeNull();
  });

  it("parses results, unwraps redirect links and drops non-onion targets", () => {
    const html = `<ol>
      <li class="result"><h4><a href="/search/redirect?search_term=x&redirect_url=http://${ONION}/page/">  Library
        mirror </a></h4><p>No description provided</p><cite>${ONION}</cite>
        <span class="lastSeen" data-timestamp="Nov. 1, 2026, 7:08 a.m.">1 week</span></li>
      <li class="result"><h4><a href="/search/redirect?search_term=x&redirect_url=https://clearnet.example/">Clear</a></h4><p>skip</p></li>
      <li class="result"><h4><a href="http://${ONION}/b">News</a></h4><p>Independent journalism.</p></li>
    </ol>`;
    const results = parseAhmiaResults(html);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ source: "ahmia", title: "Library mirror", url: `http://${ONION}/page/`, onion: true, last_seen: "Nov. 1, 2026, 7:08 a.m." });
    expect(results[0]?.snippet).toBeUndefined();
    expect(results[1]).toMatchObject({ title: "News", snippet: "Independent journalism." });
  });

  it("chooses clear web or the onion mirror", () => {
    const base = (env: Record<string, string>) => ahmiaBase(loadConfig(env).config);
    expect(base({})?.viaTor).toBe(false);
    expect(base({ DEEP_SEARCH_TOR_PROXY: "9050" })?.viaTor).toBe(true);
    expect(base({ DEEP_SEARCH_TOR_PROXY: "9050", DEEP_SEARCH_AHMIA_MODE: "clearnet" })?.viaTor).toBe(false);
    expect(base({ DEEP_SEARCH_AHMIA_MODE: "onion" })).toBeNull();
    // A Tor route beyond .onion-only keeps dark web searches off the clear web, whatever the Ahmia mode
    expect(base({ DEEP_SEARCH_TOR_PROXY: "9050", DEEP_SEARCH_TOR_ROUTE: "sensitive", DEEP_SEARCH_AHMIA_MODE: "clearnet" })?.viaTor).toBe(true);
    expect(base({ DEEP_SEARCH_TOR_ROUTE: "all" })).toBeNull();
  });
});
