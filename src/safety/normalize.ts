const LEET: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  "@": "a",
  $: "s",
  "!": "i"
};

/**
 * Canonical form used by the safety rules: lowercase, no diacritics ("criança" → "crianca"),
 * URL-ish separators turned into spaces, single spaces.
 */
export function normalizeText(input: string): string {
  let text = input;
  try {
    // Percent-encoded URLs ("child%20porn") must not slip through
    if (/%[0-9a-f]{2}/i.test(text)) text = decodeURIComponent(text.replace(/%(?![0-9a-f]{2})/gi, "%25"));
  } catch {
    // Keep the raw text if it is not valid percent-encoding
  }
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[‘’‛′`´]/g, "'")
    .replace(/[‐-―]/g, "-")
    .replace(/[_+]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Leetspeak-decoded variant ("p0rn" → "porn", "r@ygold" → "raygold"). Only characters touching
 * letters are mapped, so years and numbers keep their meaning.
 */
export function leetVariant(normalized: string): string {
  return normalized.replace(/[0134578@$!](?=[a-z])|(?<=[a-z])[0134578@$!]/g, c => LEET[c] ?? c);
}

/** Text forms every rule is tested against. */
export function textVariants(input: string): string[] {
  const normalized = normalizeText(input);
  const leet = leetVariant(normalized);
  return leet === normalized ? [normalized] : [normalized, leet];
}
