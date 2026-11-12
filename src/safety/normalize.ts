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
 * Invisible characters used to split or disguise words: every Unicode "format" character (zero-width
 * space/joiners, bidi controls, BOM, soft hyphen…) plus the Hangul and Khmer fillers that render empty.
 */
const FORMAT_CHARS = /[\p{Cf}ᅟᅠ឴឵ㅤﾠ]/gu;
const HAS_FORMAT_CHARS = /[\p{Cf}ᅟᅠ឴឵ㅤﾠ]/u;
/** Every combining mark (accents, enclosing circles, overlays), removed after NFKD decomposition. */
const COMBINING_MARKS = /\p{M}/gu;

/**
 * Cyrillic and Greek letters that look like Latin ones ("pоrn" with a Cyrillic "о"). Text is
 * lowercased first, so this also covers uppercase look-alikes such as Cyrillic "В", "Н", "М".
 */
const CONFUSABLES: Record<string, string> = {
  а: "a",
  в: "b",
  е: "e",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  с: "c",
  т: "t",
  у: "y",
  х: "x",
  і: "i",
  ј: "j",
  ѕ: "s",
  ԁ: "d",
  ӏ: "l",
  ԛ: "q",
  ԝ: "w",
  ү: "y",
  α: "a",
  β: "b",
  ε: "e",
  η: "n",
  ι: "i",
  κ: "k",
  ν: "v",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "u",
  χ: "x",
  ω: "w"
};
const CONFUSABLE_CHARS = new RegExp(`[${Object.keys(CONFUSABLES).join("")}]`, "g");

/**
 * Canonical form used by the safety rules: lowercase, no diacritics ("criança" → "crianca"),
 * invisible characters removed, URL-ish separators turned into spaces, single spaces.
 */
export function normalizeText(input: string): string {
  let text = input.replace(FORMAT_CHARS, "");
  try {
    // Percent-encoded URLs ("child%20porn") must not slip through
    if (/%[0-9a-f]{2}/i.test(text)) text = decodeURIComponent(text.replace(/%(?![0-9a-f]{2})/gi, "%25"));
  } catch {
    // Keep the raw text if it is not valid percent-encoding
  }
  return text
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
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

/** Latin reading of Cyrillic/Greek look-alike letters. */
export function homoglyphVariant(normalized: string): string {
  return normalized.replace(CONFUSABLE_CHARS, c => CONFUSABLES[c] ?? c);
}

/**
 * Text forms every rule is tested against: the normalized text, its leetspeak and look-alike
 * readings, and, when invisible characters are present, a reading where they break words.
 */
export function textVariants(input: string): string[] {
  const variants = new Set<string>();
  const add = (normalized: string) => {
    for (const form of new Set([normalized, homoglyphVariant(normalized)])) {
      variants.add(form);
      variants.add(leetVariant(form));
    }
  };
  add(normalizeText(input)); // "p​thc" → "pthc"
  if (HAS_FORMAT_CHARS.test(input)) add(normalizeText(input.replace(FORMAT_CHARS, " "))); // "teen​nudes" → "teen nudes"
  return [...variants];
}
