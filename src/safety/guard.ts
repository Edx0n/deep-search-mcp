import type { Channel } from "../types.js";
import { textVariants } from "./normalize.js";
import { CATEGORIES, type Category, type CategoryId, type Rule } from "./rules.js";

export interface PolicyEntry {
  id: CategoryId;
  label: string;
  description: string;
  locked: boolean;
  enabled: boolean;
}

export interface DocumentVerdict {
  /** Category that blocks the document, or null when it may be shown. */
  category: CategoryId | null;
  hits: Partial<Record<CategoryId, number>>;
}

/** A long page needs this many hits of a non-locked category before it is withheld (one stray mention is not enough). */
export const DOCUMENT_THRESHOLD = 3;

const globalRegexes = new WeakMap<RegExp, RegExp>();
function globalOf(re: RegExp): RegExp {
  let g = globalRegexes.get(re);
  if (!g) {
    g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    globalRegexes.set(re, g);
  }
  return g;
}

function countMatches(rule: Rule, variants: string[], cap: number): number {
  let best = 0;
  const re = globalOf(rule.re);
  for (const text of variants) {
    re.lastIndex = 0;
    let n = 0;
    while (n < cap && re.exec(text) !== null) {
      n++;
      if (re.lastIndex === 0) break;
    }
    best = Math.max(best, n);
  }
  return best;
}

/** Applies the safety policy: query refusal, result filtering and page screening. */
export class SafetyGuard {
  private readonly active: Category[];
  /** Categories switched off by configuration. */
  readonly disabled: CategoryId[];
  /** Disable requests that were ignored (locked or unknown categories), for a startup warning. */
  readonly ignored: string[];

  constructor(disableRequests: readonly string[] = []) {
    const disabled = new Set<CategoryId>();
    const ignored: string[] = [];
    for (const raw of disableRequests) {
      const id = raw.trim().toLowerCase();
      if (!id) continue;
      const category = CATEGORIES.find(c => c.id === id);
      if (!category) ignored.push(`"${raw}" (unknown category)`);
      else if (category.locked) ignored.push(`"${raw}" (locked: it can never be disabled)`);
      else disabled.add(category.id);
    }
    this.disabled = [...disabled];
    this.ignored = ignored;
    this.active = CATEGORIES.filter(c => !disabled.has(c.id));
  }

  static label(id: CategoryId): string {
    return CATEGORIES.find(c => c.id === id)?.label ?? id;
  }

  policy(): PolicyEntry[] {
    return CATEGORIES.map(c => ({
      id: c.id,
      label: c.label,
      description: c.description,
      locked: c.locked,
      enabled: !this.disabled.includes(c.id)
    }));
  }

  /** Channels on which this query must not be searched at all, with the category that triggered the refusal. */
  checkQuery(query: string): Map<Channel, CategoryId> {
    const variants = textVariants(query);
    const refused = new Map<Channel, CategoryId>();
    for (const category of this.active) {
      for (const rule of category.rules) {
        if (rule.refuseQuery.length === 0 || rule.refuseQuery.every(ch => refused.has(ch))) continue;
        if (variants.some(v => rule.re.test(v))) {
          for (const channel of rule.refuseQuery) {
            if (!refused.has(channel)) refused.set(channel, category.id);
          }
        }
      }
    }
    return refused;
  }

  /** Category that hides a short text (result title + snippet + URL) on this channel, or null. */
  classify(text: string, channel: Channel): CategoryId | null {
    const variants = textVariants(text);
    for (const category of this.active) {
      for (const rule of category.rules) {
        if (rule.channels.includes(channel) && variants.some(v => rule.re.test(v))) return category.id;
      }
    }
    return null;
  }

  /**
   * Screens a long document (a fetched page). Locked categories block on a single hit;
   * the others need DOCUMENT_THRESHOLD hits so that news or research merely mentioning a topic still passes.
   */
  checkDocument(text: string, channel: Channel): DocumentVerdict {
    const variants = textVariants(text);
    const hits: Partial<Record<CategoryId, number>> = {};
    let blocking: CategoryId | null = null;
    for (const category of this.active) {
      const threshold = category.locked ? 1 : DOCUMENT_THRESHOLD;
      let count = 0;
      for (const rule of category.rules) {
        if (!rule.channels.includes(channel)) continue;
        count += countMatches(rule, variants, threshold - count);
        if (count >= threshold) break;
      }
      if (count > 0) hits[category.id] = count;
      if (count >= threshold && blocking === null) blocking = category.id;
    }
    return { category: blocking, hits };
  }
}
