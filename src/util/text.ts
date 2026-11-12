const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  copy: "©",
  reg: "®",
  deg: "°",
  middot: "·",
  bull: "•",
  shy: ""
};

/** Decodes the HTML entities that commonly show up in API abstracts. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

const PERCENT_RUN = /(?:%[0-9a-f]{2})+/gi;
const utf8 = new TextDecoder("utf-8", { fatal: false });

/**
 * Lenient percent-decoding, repeated until stable (double/triple/… encoding): every run of %XX bytes
 * is decoded on its own, so one invalid byte ("%FF") cannot switch decoding off for the rest of the
 * string, as decodeURIComponent would. Invalid sequences become U+FFFD.
 */
export function percentDecodeAll(input: string, maxRounds = 8): string {
  let current = input;
  for (let round = 0; round < maxRounds && current.includes("%"); round++) {
    const next = current.replace(PERCENT_RUN, run => {
      const bytes = new Uint8Array(run.length / 3);
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
      return utf8.decode(bytes);
    });
    if (next === current) break;
    current = next;
  }
  return current;
}

/** Longest input stripTags looks at: it feeds snippets of at most a few hundred characters. */
const STRIP_INPUT_LIMIT = 20_000;

/**
 * Removes tags (including JATS/MathML markup in abstracts), decodes entities and collapses whitespace.
 * Linear time on hostile input: `[^<>]` stops a failed match at the next "<", and input is capped
 * (descriptions come from user-editable records such as Internet Archive items).
 */
export function stripTags(html: string): string {
  return collapse(decodeEntities(html.slice(0, STRIP_INPUT_LIMIT).replace(/<[^<>]*>/g, " ")));
}

export function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Shortens text to at most `max` characters, cutting at a word boundary when possible. */
export function clip(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  const t = collapse(text);
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** First non-empty string of a value that may be a string, an array of strings or missing. */
export function firstString(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return undefined;
}

export function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

export function toYear(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value === "string") {
    const m = value.match(/\b(1[5-9]\d\d|2[01]\d\d)\b/);
    if (m) return Number(m[1]);
  }
  return undefined;
}

/** Strips the resolver prefix from a DOI ("https://doi.org/10.1/x" → "10.1/x"). */
export function cleanDoi(doi: string | undefined | null): string | undefined {
  if (!doi) return undefined;
  const d = doi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "");
  return /^10\.\d{4,9}\//.test(d) ? d : undefined;
}

/** Hostname of a URL without "www.", lowercase; empty string when the URL is invalid. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Key used to spot the same document across sources. */
export function dedupeKey(url: string, doi?: string): string {
  if (doi) return `doi:${doi.toLowerCase()}`;
  try {
    const u = new URL(url);
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref$|ref_)/i.test(p)) u.searchParams.delete(p);
    }
    const path = u.pathname.replace(/\/+$/, "");
    return `url:${u.hostname.toLowerCase().replace(/^www\./, "")}${path}${u.search}`;
  } catch {
    return `raw:${url}`;
  }
}

/**
 * Makes a free-text query safe for Lucene/Elasticsearch query-string APIs:
 * drops operators and brackets that would cause syntax errors, keeps words, quotes and inner hyphens.
 */
export function sanitizeLucene(query: string): string {
  let q = query.replace(/[\\/:(){}[\]^~!?*+<>=|&]/g, " ");
  q = q.replace(/(^|\s)-+/g, "$1").replace(/-+(\s|$)/g, "$1");
  if ((q.match(/"/g) ?? []).length % 2 === 1) q = q.replace(/"/g, " ");
  return collapse(q);
}

export function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}
