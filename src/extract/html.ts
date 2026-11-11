import { load, type CheerioAPI } from "cheerio";
import { collapse } from "../util/text.js";

export interface ExtractedLink {
  text: string;
  url: string;
}

export interface ExtractedPage {
  title?: string;
  description?: string;
  language?: string;
  text: string;
  links: ExtractedLink[];
}

const DROP = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "frame",
  "object",
  "embed",
  "video",
  "audio",
  "picture",
  "img",
  "source",
  "track",
  "map",
  "button",
  "input",
  "select",
  "textarea",
  "link",
  "meta",
  "[hidden]",
  "[aria-hidden='true']"
].join(",");

const CHROME = "nav, footer, aside, [role='navigation'], [role='banner'], [role='contentinfo'], .cookie, #cookie, .cookies";

const BLOCK = new Set([
  "p",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "nav",
  "aside",
  "main",
  "ul",
  "ol",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "blockquote",
  "dl",
  "dt",
  "dd",
  "figure",
  "figcaption",
  "address",
  "details",
  "summary",
  "form",
  "fieldset",
  "center",
  "body",
  "html"
]);

interface DomNode {
  type: string;
  name?: string;
  data?: string;
  children?: DomNode[];
}

function walk($: CheerioAPI, node: DomNode, out: string[]): void {
  if (node.type === "text") {
    out.push((node.data ?? "").replace(/\s+/g, " "));
    return;
  }
  if (node.type !== "tag" && node.type !== "root") return;
  const tag = node.name ?? "";
  const children = () => {
    for (const child of node.children ?? []) walk($, child, out);
  };
  if (tag === "br") {
    out.push("\n");
    return;
  }
  if (tag === "hr") {
    out.push("\n\n---\n\n");
    return;
  }
  if (/^h[1-6]$/.test(tag)) {
    out.push(`\n\n${"#".repeat(Number(tag[1]))} `);
    children();
    out.push("\n\n");
    return;
  }
  if (tag === "li") {
    out.push("\n- ");
    children();
    out.push("\n");
    return;
  }
  if (tag === "pre") {
    out.push(`\n\n\`\`\`\n${$(node as never).text().replace(/\n+$/, "")}\n\`\`\`\n\n`);
    return;
  }
  if (tag === "td" || tag === "th") {
    children();
    out.push(" | ");
    return;
  }
  if (tag === "p" || tag === "blockquote") {
    out.push("\n\n");
    children();
    out.push("\n\n");
    return;
  }
  const block = BLOCK.has(tag);
  if (block) out.push("\n");
  children();
  if (block) out.push("\n");
}

function tidy(raw: string): string {
  let inCode = false;
  return raw
    .split("\n")
    .map(line => {
      if (line.trim() === "```") {
        inCode = !inCode;
        return "```";
      }
      // Preformatted blocks keep their spacing
      if (inCode) return line.replace(/\s+$/, "");
      return line.replace(/[ \t]+/g, " ").replace(/(\s*\|\s*)+$/, "").trim();
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isUsefulHref(href: string): boolean {
  return !/^(javascript:|mailto:|tel:|data:|#)/i.test(href.trim());
}

/** Converts an HTML page to readable text (headings, lists, paragraphs) plus its outgoing links. */
export function extractHtml(html: string, baseUrl: string, maxLinks = 80): ExtractedPage {
  const $ = load(html);
  const title = collapse($("title").first().text()) || $("meta[property='og:title']").attr("content")?.trim() || undefined;
  const description =
    $("meta[name='description']").attr("content")?.trim() || $("meta[property='og:description']").attr("content")?.trim() || undefined;
  const language = $("html").attr("lang")?.trim() || undefined;

  // Links come from the whole page (navigation included): they are how an investigation moves on.
  const links: ExtractedLink[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_, el) => {
    if (links.length >= maxLinks) return;
    const href = $(el).attr("href");
    if (!href || !isUsefulHref(href)) return;
    let url: string;
    try {
      const u = new URL(href, baseUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") return;
      u.hash = "";
      url = u.toString();
    } catch {
      return;
    }
    if (seen.has(url)) return;
    seen.add(url);
    links.push({ text: collapse($(el).text()).slice(0, 120) || url, url });
  });

  $(DROP).remove();
  const candidates = $("article, main, [role='main']")
    .toArray()
    .map(el => ({ el, length: collapse($(el).text()).length }))
    .sort((a, b) => b.length - a.length);
  // cheerio always builds <html><body>, even for fragments, so "body" exists
  let root = candidates[0] && candidates[0].length >= 500 ? $(candidates[0].el) : $("body");
  if (root.is("body")) {
    const withoutChrome = root.clone();
    withoutChrome.find(CHROME).remove();
    if (collapse(withoutChrome.text()).length >= 200) root = withoutChrome;
  }

  const out: string[] = [];
  for (const node of root.toArray() as unknown as DomNode[]) walk($, node, out);
  return { title, description, language, text: tidy(out.join("")), links };
}
