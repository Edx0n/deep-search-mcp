import type { Channel } from "../types.js";

/**
 * Safety rules. They run on normalized text (see normalize.ts): lowercase, no accents, "_"/"+"
 * turned into spaces. Every rule says on which channels it filters results and on which channels
 * a matching *query* is refused before any request is made.
 *
 * Design principles
 * - Locked categories can never be disabled by configuration.
 * - Non-locked rules target listings/transactions ("buy cocaine", "guns for sale"), not topics,
 *   so news and research about those subjects still come through on the open web.
 * - The academic channel (curated scholarly metadata) only gets unambiguous abuse slang.
 */

export const CATEGORY_IDS = [
  "csam",
  "exploitation",
  "mass_harm",
  "sexual",
  "gore",
  "violence_for_hire",
  "weapons",
  "drugs",
  "fraud",
  "hacking_services",
  "extremism"
] as const;
export type CategoryId = (typeof CATEGORY_IDS)[number];

export interface Rule {
  re: RegExp;
  /** Channels where a result/page matching this rule is hidden. */
  channels: readonly Channel[];
  /** Channels for which a query matching this rule is refused outright. */
  refuseQuery: readonly Channel[];
}

export interface Category {
  id: CategoryId;
  label: string;
  description: string;
  locked: boolean;
  rules: Rule[];
}

const ALL: readonly Channel[] = ["academic", "web", "darkweb"];
const OPEN: readonly Channel[] = ["web", "darkweb"];
const DARK: readonly Channel[] = ["darkweb"];
const NONE: readonly Channel[] = [];

const alt = (...parts: string[]): string => `(?:${parts.join("|")})`;

/** Up to `gap` intermediate words. */
const gapOf = (gap: number): string => `(?:\\W+\\w+){0,${gap}}?\\W+`;

/** `a` and `b` within `gap` words of each other, in either order. */
function near(a: string, b: string, gap = 3): string {
  return `(?:\\b${a}\\b${gapOf(gap)}${b}\\b|\\b${b}\\b${gapOf(gap)}${a}\\b)`;
}

/** A word whose letters may be separated by dots/spaces ("p.t.h.c", "p t h c"). */
function spaced(word: string): string {
  return `\\b${word.split("").join("\\W{0,2}")}\\b`;
}

function rule(source: string, channels: readonly Channel[], refuseQuery: readonly Channel[] = NONE): Rule {
  return { re: new RegExp(source, "i"), channels, refuseQuery };
}

// ---------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------

const MINOR = alt(
  "child",
  "children",
  "childs",
  "kids?",
  "kiddie",
  "kiddy",
  "minors?",
  "under\\W?aged?",
  "pre\\W?teens?",
  "tweens?",
  "toddlers?",
  "infant(?:s|il|is)?",
  "babies",
  "school\\W?girls?",
  "school\\W?boys?",
  "young(?:er)? (?:girls?|boys?)",
  "little (?:girls?|boys?)",
  "crianc(?:a|as)",
  "menor(?:es)?",
  "menin(?:a|as|o|os)",
  "novinh(?:a|as|o|os)",
  "ninfet(?:a|as)",
  "nin(?:as|os)",
  "colegia(?:l|is|les|las?)",
  "lolitas?",
  "kinder",
  "enfants?",
  "mineur(?:e|es|s)?"
);

/** Explicit ages under 18 ("12yo", "15 years old", "14 anos"). */
const AGE_MINOR = "(?:[1-9]|1[0-7])\\W?(?:yo|y\\W?o|years?\\W?old|anos|ans)";

const TEEN = alt("teens?", "teenagers?", "teenage", "adolescent(?:e|es|s)?");

const PORN = alt(
  "porn\\w*",
  "xxx",
  "nsfw",
  "nudes?",
  "naked",
  "nuas?",
  "pelad(?:a|as|o|os|inha|inhas)",
  "desnud(?:a|as|o|os)",
  "hardcore",
  "sex\\W?tapes?",
  "sex\\W?videos?",
  "onlyfans",
  "lewds?",
  "hentai",
  "erotic\\w*",
  "sexy",
  "fuck\\w*",
  "blowjobs?",
  "masturbat\\w*",
  "putaria",
  "bucetinhas?",
  "peitinhos?"
);

const SEXUAL_BROAD = alt(
  "sex",
  "sexo",
  "sexual\\w*",
  "sexuais",
  "sexting",
  "molest\\w*",
  "rap(?:e|es|ed|ing)",
  "estupr\\w*",
  "abus(?:e|es|ed|ing|o|os|ad[ao]s?)",
  "grooming",
  "aliciament\\w*",
  "exploit\\w*",
  "exploracao",
  "explotacion",
  "intim(?:a|as|o|os)"
);

/** Verbs/nouns of a transaction ("buy", "for sale", "vendo"). */
const TRADE = alt(
  "buy\\w*",
  "sell\\w*",
  "for sale",
  "on sale",
  "shops?",
  "vendors?",
  "purchas\\w*",
  "cheap",
  "comprar",
  "compro",
  "compra",
  "vend(?:o|e|er|emos|a|as|endo)",
  "a venda",
  "loja",
  "entregamos",
  "delivery to your door"
);

// ---------------------------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------------------------

const csam: Category = {
  id: "csam",
  label: "Child sexual abuse material",
  description:
    "Sexualized content involving minors and the slang used to trade it. Queries are refused on web/dark web; results and pages are always hidden.",
  locked: true,
  rules: [
    // Trade slang with no legitimate meaning: filtered everywhere, including academic metadata
    rule(alt(spaced("pthc"), spaced("ptsc"), "\\bhurt\\W?core\\b", "\\blolicon\\b", "\\bshotacon\\b", "\\bhussyfan\\b", "\\braygold\\b", "\\bbabyshivid\\b"), ALL, OPEN),
    // Explicit sexual terms next to minor terms
    rule(near(MINOR, PORN, 3), OPEN, OPEN),
    rule(near(AGE_MINOR, PORN, 3), OPEN, OPEN),
    rule(near(TEEN, PORN, 2), OPEN, OPEN),
    rule(
      alt(
        "\\bjail\\W?bait\\b",
        "\\bloli\\b",
        "\\bpedo\\W?(?:porn\\w*|videos?|pics?|links?|hub|boards?|forums?|chans?|collections?|mom|dad)\\b",
        "\\bpedoporn\\w*",
        "\\bpedopornograf\\w*",
        "\\bkinderporn\\w*",
        "\\bkidd(?:ie|y)\\W?porn\\w*",
        "\\bkid\\W?porn\\w*",
        "\\bchild\\W?porn\\w*",
        "\\bporn\\w* infantil\\w*",
        "\\bpornografia (?:de menores|infantil)",
        // Bounded quantifiers: \S* here would be quadratic on long runs without spaces
        "детск\\S{0,12}\\s{1,3}порн",
        "порн\\S{0,12}\\s{1,3}детск"
      ),
      OPEN,
      OPEN
    ),
    rule(
      `\\bcp\\W+${alt("porn\\w*", "videos?", "vids?", "pics?", "photos?", "links?", "collections?", "archives?", "packs?", "sites?", "forums?", "boards?", "chans?", "hub", "onion", "mega", "leaks?", "content", "material", "tube", "girls?", "boys?", "kids?")}\\b`,
      OPEN,
      OPEN
    ),
    rule(`\\b${alt("free", "best", "new", "fresh", "real", "hidden", "onion", "tor", "dark\\W?web", "deep\\W?web")}\\W+cp\\b`, OPEN, OPEN),
    // Topic words: on the dark web they essentially only point to abuse content
    rule(near(MINOR, SEXUAL_BROAD, 3), DARK, DARK),
    rule(near(AGE_MINOR, SEXUAL_BROAD, 3), DARK, DARK),
    rule(
      alt(
        "\\bcsam\\b",
        "\\bcsem\\b",
        "\\bchild (?:sexual )?(?:abuse|exploitation)\\b",
        "\\bp(?:a)?edo(?:phil\\w*|fil\\w*|s)?\\b",
        "\\babuso sexual (?:infantil|de menores|de criancas)",
        "\\bexplotacion sexual infantil",
        "педофил"
      ),
      DARK,
      DARK
    )
  ]
};

const exploitation: Category = {
  id: "exploitation",
  label: "Human exploitation & non-consensual intimate content",
  description:
    "Human/organ trafficking, sexual slavery, leaked or covert intimate imagery (revenge porn, hidden cameras, deepfake nudes) and bestiality.",
  locked: true,
  rules: [
    rule(
      alt(
        "\\bonlyfans\\W?leaks?\\b",
        near(alt("nudes?", "intim(?:a|as|o|os)", "pelad(?:a|as|o|os)", "privad(?:a|as|o|os)"), alt("vazad(?:a|as|o|os)", "leak(?:ed|s)?"), 1),
        "\\bupskirts?\\b",
        "\\bcreep\\W?shots?\\b",
        "\\b(?:hidden|spy)\\W?cam(?:era)?s?\\W+(?:porn\\w*|sex|nudes?)\\b",
        "\\bvoyeur\\W+(?:porn\\w*|sex)\\b",
        "\\bdeep\\W?fakes?\\W+(?:porn\\w*|nudes?|nsfw|sex)\\b",
        "\\bdeep\\W?nudes?\\b",
        "\\b(?:nudify|undress)\\W+(?:app|apps|ai|bot|bots|tool|tools|online)\\b",
        "\\bbestiality\\b",
        "\\bzoophil\\w*",
        "\\bzoofilia\\b",
        "\\bhuman (?:organs?|kidneys?) (?:for sale|a venda|market)\\b",
        "\\bkidneys? for sale\\b"
      ),
      OPEN,
      DARK
    ),
    rule(
      alt(
        near(
          TRADE,
          alt("slaves?", "girls?", "women", "wives", "brides?", "virgins?", "children", "kids?", "babies", "human organs?", "kidneys?", "escrav(?:a|as|o|os)", "mulheres", "meninas", "criancas", "bebes", "orgaos humanos"),
          2
        ),
        "\\b(?:human|sex) trafficking\\b",
        "\\btrafico (?:humano|de pessoas|de orgaos)\\b",
        "\\btrata de (?:personas|blancas)\\b",
        "\\bsex(?:ual)? slaves?\\b",
        "\\bescrav(?:a|as|o|os) sexua(?:l|is)\\b",
        "\\bsextort\\w*",
        "\\bsextorsao\\b",
        "\\brevenge porn\\w*",
        "\\b(?:organs?|kidneys?|livers?|orgaos|rins?) (?:for sale|a venda|black market|trafficking)\\b"
      ),
      DARK,
      DARK
    )
  ]
};

const MAKE = alt(
  "make",
  "making",
  "build",
  "building",
  "create",
  "manufactur\\w*",
  "synthesi[sz]\\w*",
  "produc\\w*",
  "assembl\\w*",
  "cook",
  "fabricar",
  "fazer",
  "montar",
  "construir",
  "produzir",
  "sintetizar",
  "preparar",
  "hacer"
);
const BOMB =
  "(?<!\\b(?:bath|seed|photo|f|stink|smoke|glitter|cherry|water|flavou?r|calorie|sex|love|time|truth) )bombs?(?!\\W+(?:shelters?|calorimet\\w*|cyclones?|jackets?|pops?|squads?|disposal|threats?))";
const BOMBA =
  "bombas?(?![^.]{0,28}(?:agua|hidraul|chocolate|combustivel|gasolina|vacuo|calor|piscina|submers|injetora|centrifug|dosadora|peristalt|pneu|bicicleta|insulina|infusao|succao|oleo|ar comprimido|aquario|poco|irrigac|vacina|cafe))";
const MASS_HARM = alt(
  BOMB,
  "pipe\\W?bombs?",
  "ieds?",
  "explosive devices?",
  "explosives",
  "car\\W?bombs?",
  "dirty\\W?bombs?",
  "nerve\\W?agents?",
  "sarin",
  "tabun",
  "soman",
  "novichok",
  "ricin",
  "abrin",
  "anthrax",
  "botulinum toxin",
  "mustard\\W?gas",
  "chemical\\W?weapons?",
  "biological\\W?weapons?",
  "bio\\W?weapons?",
  "napalm",
  "tatp",
  "petn",
  "rdx",
  "nitroglycerin\\w*",
  "thermite",
  "molotov\\w*",
  BOMBA,
  "explosivos caseiros",
  "artefatos? explosivos?",
  "armas? quimicas?",
  "armas? biologicas?",
  "gas sarin",
  "ricina",
  "antraz",
  "coquetel molotov",
  "granadas? caseiras?"
);

const massHarm: Category = {
  id: "mass_harm",
  label: "Explosives & weapons of mass harm (instructions)",
  description: "How-to material for bombs, explosives and chemical/biological weapons.",
  locked: true,
  rules: [
    rule(`\\bhow (?:to|do i|can i|do you|would i)\\W+${MAKE}\\b${gapOf(3)}${MASS_HARM}\\b`, OPEN, OPEN),
    rule(`\\b(?:como|comment) (?:se )?${MAKE}\\b${gapOf(3)}${MASS_HARM}\\b`, OPEN, OPEN),
    rule(
      near(MASS_HARM, alt("recipes?", "manuals?", "tutorials?", "instructions?", "cookbooks?", "blueprints?", "synthesis", "receitas?", "tutoriais", "instrucoes", "recetas?", "instrucciones"), 1),
      OPEN,
      OPEN
    ),
    rule(`\\b${alt(BOMB, "explosives?", "ied", "pipe\\W?bombs?")}\\W?(?:making|maker|building|recipe)\\b`, OPEN, OPEN),
    rule("\\banarchist'?s? cookbook\\b", OPEN, OPEN)
  ]
};

const sexual: Category = {
  id: "sexual",
  label: "Sexually explicit content",
  description: "Pornography, escort/cam services and adult-site listings.",
  locked: false,
  rules: [
    rule(
      alt(
        "\\bporn\\w*",
        "\\bxxx\\b",
        "\\bnsfw\\b",
        "\\bhentai\\b",
        "\\bsex\\W?(?:videos?|tapes?|cams?|chats?|shops?|toys?|dolls?)\\b",
        "\\bnudes\\b",
        "\\bnude (?:pics?|photos?|videos?|girls?|women|men|selfies?|leaks?)\\b",
        "\\bnaked (?:girls?|women|men|pics?|photos?|videos?|selfies?)\\b",
        "\\bescort (?:services?|girls?|agenc\\w*|ladies)\\b",
        "\\bacompanhantes?\\b",
        "\\bgarotas? de programa\\b",
        "\\bcam\\W?girls?\\b",
        "\\bcam (?:models?|shows?|sex)\\b",
        "\\bwebcam (?:sex|girls?|shows?)\\b",
        "\\bonlyfans\\b",
        "\\bfansly\\b",
        "\\bputaria\\b",
        "\\bsexo (?:explicito|ao vivo|gratis|amador|anal|oral|virtual)\\b",
        "\\bvideos? (?:porno|de sexo|eroticos?)\\b",
        "\\berotic (?:videos?|stories|massage|photos?|chat)\\b",
        "\\bfetish\\w*",
        "\\bbdsm\\b",
        "\\bmilfs?\\b",
        "\\b(?:xvideos|pornhub|xhamster|redtube|youporn|brazzers|chaturbate|stripchat|camsoda|bongacams|xnxx)\\b",
        "\\bnudez\\b",
        "\\badult (?:videos?|content|sites?|dating|webcams?)\\b"
      ),
      OPEN
    )
  ]
};

const GORE_CONTEXT = alt("videos?", "vids?", "sites?", "footage", "pics?", "photos?", "forums?", "real", "extreme", "content", "channels?", "tube", "brasil", "br", "fotos");
const gore: Category = {
  id: "gore",
  label: "Gore & extreme violence media",
  description: "Gore/snuff sites, torture and execution videos, necrophilia.",
  locked: false,
  rules: [
    rule("(?<!\\bal )\\bgore\\b(?!\\W?tex)", DARK),
    rule(
      alt(
        `(?<!\\bal )\\bgore\\W+(?:\\w+\\W+)?${GORE_CONTEXT}\\b`,
        `\\b${GORE_CONTEXT}\\W+(?:\\w+\\W+)?gore\\b(?!\\W?tex)`,
        "\\bsnuff (?:films?|movies?|videos?|porn\\w*)\\b",
        "\\bred\\W?rooms? (?:live|torture|streams?)\\b",
        "\\bbeheading (?:videos?|footage|clips?)\\b",
        "\\bdecapitat\\w* videos?\\b",
        "\\btorture (?:videos?|footage|porn\\w*|live|streams?)\\b",
        "\\bexecution (?:videos?|footage)\\b",
        "\\b(?:real )?death videos?\\b",
        "\\bmurder (?:videos?|footage|live\\W?streams?)\\b",
        "\\bdismember\\w* (?:videos?|photos?|footage)\\b",
        "\\bnecrophil\\w*",
        "\\bnecrofilia\\b",
        "\\bvideos? de (?:mortes?|assassinatos?|tortura|decapitac\\w*|execuc\\w*|acidentes? fatais)\\b",
        "\\bcadaver (?:porn\\w*|sex)\\b",
        "\\bwatch\\W?people\\W?die\\b",
        "\\bbestgore\\b",
        "\\bkaotic\\b"
      ),
      OPEN
    ),
    rule("\\bred\\W?rooms?\\b", DARK)
  ]
};

const violenceForHire: Category = {
  id: "violence_for_hire",
  label: "Violence for hire",
  description: "Hitman, murder-for-hire, kidnapping or assault services (nearly always scams, never legitimate).",
  locked: false,
  rules: [
    rule(
      alt(
        "\\bhit\\W?m[ae]n (?:for hire|services?|available|contracts?)\\b",
        "\\b(?:hire|rent|find) (?:a |an )?(?:hit\\W?man|killer|assassin|sicario)\\b",
        "\\bmurder (?:for hire|as a service)\\b",
        "\\bkill(?:ing)? (?:for hire|services?|for money)\\b",
        "\\bcontract (?:killers?|killings?)\\b",
        "\\bassassins? (?:for hire|services?|market|network)\\b",
        "\\bassassination (?:services?|market)\\b",
        "\\bmatador(?:es)? de aluguel\\b",
        "\\bpistoleir(?:a|as|o|os) de aluguel\\b",
        "\\bsicarios? (?:de aluguel|for hire|en renta|a sueldo)\\b",
        "\\b(?:mandar|encomendar) (?:matar|assassinar)\\b",
        "\\b(?:acid attacks?|beat\\W?ups?|beatings?|kidnapping|arson) (?:services?|for hire)\\b"
      ),
      OPEN
    ),
    rule("\\bhit\\W?men\\b", DARK)
  ]
};

const WEAPON = alt(
  "guns?",
  "handguns?",
  "firearms?",
  "pistols?",
  "rifles?",
  "shotguns?",
  "revolvers?",
  "glocks?",
  "ak\\W?47s?",
  "ar\\W?15s?",
  "uzis?",
  "ammo",
  "ammunition",
  "silencers?",
  "suppressors?",
  "grenades?",
  "explosives?",
  "semtex",
  "armas?",
  "municao",
  "municoes",
  "fuzis",
  "fuzil",
  "pistolas?",
  "revolver(?:es)?",
  "granadas?",
  "explosivos?",
  "metralhadoras?",
  "submetralhadoras?"
);
const weapons: Category = {
  id: "weapons",
  label: "Weapons trade",
  description: "Sale of firearms, ammunition, explosives, untraceable or 3D-printed guns.",
  locked: false,
  rules: [
    rule(near(alt(TRADE, "stores?"), WEAPON, 2), OPEN),
    rule(
      alt(
        "\\barms? dealers?\\b",
        "\\bghost\\W?guns?\\b",
        "\\buntraceable (?:guns?|firearms?|weapons?)\\b",
        "\\b3d\\W?print\\w* (?:guns?|firearms?|pistols?|rifles?|weapons?)\\b",
        "\\b(?:gun|firearm|weapon) (?:blueprints?|stl files?|cad files?)\\b",
        "\\barmas? (?:sem registro|raspad(?:a|as)|ilegais)\\b"
      ),
      OPEN
    )
  ]
};

const DRUG = alt(
  "cocaine",
  "crack cocaine",
  "heroin",
  "meth",
  "methamphetamine",
  "crystal meth",
  "mdma",
  "ecstasy",
  "lsd",
  "acid tabs?",
  "ketamine",
  "fentanyl",
  "carfentanil",
  "oxycodone",
  "oxycontin",
  "xanax",
  "alprazolam",
  "opioids?",
  "opiates?",
  "cannabis",
  "weed(?!\\W?(?:killers?|control|eaters?|whackers?|barriers?))",
  "marijuana",
  "marihuana",
  "hashish",
  "psilocybin",
  "shrooms",
  "magic mushrooms",
  "dmt",
  "cocaina",
  "maconha",
  "haxixe",
  "lanca\\W?perfume",
  "metanfetamina",
  "heroina",
  "drogas?",
  "drugs?",
  "pills?",
  "comprimidos",
  "skunk",
  "benzos?",
  "adderall",
  "tramadol",
  "codeine",
  "mephedrone",
  "mdpv",
  "pedra de crack"
);
const drugs: Category = {
  id: "drugs",
  label: "Drug sales",
  description: "Shops and vendors selling illegal or prescription-only drugs.",
  locked: false,
  rules: [
    rule(near(TRADE, DRUG, 2), OPEN),
    rule(
      alt(
        "\\b(?:drugs?|drogas?) (?:shops?|vendors?|lojas?)\\b",
        "\\bvendor shops?\\b",
        "\\bweed delivery\\b",
        "\\bcocaina pura\\b",
        "\\bstealth shipping\\b"
      ),
      OPEN
    )
  ]
};

const fraud: Category = {
  id: "fraud",
  label: "Fraud, carding & stolen data",
  description: "Carding, stolen accounts or databases for sale, counterfeit money and documents, laundering and scam kits.",
  locked: false,
  rules: [
    rule(
      alt(
        "\\bcarding (?:forums?|shops?|tutorials?|methods?|guides?|sites?|groups?)\\b",
        "\\bcarders? (?:forums?|shops?|markets?)\\b",
        "\\bcvvs?\\d?\\W+(?:shops?|stores?|for sale|dumps?|fresh|valid|live|base|bins?)\\b",
        "\\b(?:buy|sell|fresh|valid|live) cvvs?\\d?\\b",
        "\\bfullz\\b",
        "\\b(?:cc|credit card|card) dumps?\\b",
        "\\bdumps? (?:with pin|\\+ ?pin|shops?|track ?[12])\\b",
        "\\btrack ?[12] (?:dumps?|data)\\b",
        "\\bbank logs?\\b",
        "\\bcc (?:shops?|stores?|checkers?)\\b",
        "\\b(?:credit|debit) cards? (?:for sale|shops?|stores?|dumps?|numbers? for sale)\\b",
        "\\b(?:stolen|hacked|cloned|clone) (?:credit cards?|debit cards?|cards|accounts?|paypal|bank accounts?|identit(?:y|ies))\\b",
        "\\bcart(?:ao|oes) clonad(?:o|os)\\b",
        "\\bclonar cart(?:ao|oes)\\b",
        "\\bnotas? falsas?\\b",
        "\\bdinheiro falso\\b",
        "\\bcounterfeit (?:money|bills?|notes|banknotes|euros?|dollars?|usd|eur|currency|passports?|ids?|documents?|cash)\\b",
        "\\bfake (?:passports?|ids?|id cards?|drivers?\\W?licen[cs]es?|documents?|diplomas?|degrees?|bank\\W?notes|money)\\b",
        "\\bdocumentos? falsos?\\b",
        "\\bdiplomas? falsos?\\b",
        "\\b(?:rg|cnh|cpf|passaporte|identidade) fals(?:o|a|os|as)\\b",
        "\\b(?:ssn|social security numbers?) (?:for sale|lookup|dumps?)\\b",
        `\\b(?:paypal|bank|netflix|amazon|instagram|whatsapp|spotify|steam|uber|ifood|nubank|picpay|mercado pago) (?:accounts?|logins?|contas?)\\W+${alt("for sale", "shops?", "cheap", "a venda", "baratas?")}\\b`,
        "\\bmoney laundering (?:services?|as a service)\\b",
        "\\blavagem de dinheiro (?:servicos?)\\b",
        "\\bcash\\W?outs? (?:services?|methods?|guides?)\\b",
        "\\bpaine(?:l|is) de consultas?\\b",
        "\\bpuxar dados\\b",
        `\\b(?:dados|base de dados|banco de dados|databases?|db) (?:vazad(?:a|as|o|os)|leaks?|dumps?)\\W+${alt("venda", "a venda", "comprar", "for sale", "shop")}\\b`,
        "\\bkits? (?:de )?golpes?\\b",
        "\\b(?:scripts?|materia(?:l|is)|metodos?) (?:de|pra|para) golpes?\\b"
      ),
      OPEN
    )
  ]
};

const hacking: Category = {
  id: "hacking_services",
  label: "Hacking & malware services",
  description: "Hacker-for-hire, DDoS-for-hire, malware/ransomware/stealer logs for sale, account hijacking and stalkerware.",
  locked: false,
  rules: [
    rule(
      alt(
        "\\bhack(?:ers?|ing)? for hire\\b",
        "\\b(?:hire|rent) (?:a |an )?hackers?\\b",
        "\\bhacking services?\\b",
        "\\b(?:d?dos) (?:for hire|services?|attacks? for hire)\\b",
        "\\bbooters?\\b",
        "\\b(?:ip )?stressers?\\b",
        "\\bransomware (?:as a service|for sale|kits?|builders?|affiliate\\w*)\\b",
        `\\b${alt("malware", "rats?", "keyloggers?", "stealers?", "infostealers?", "botnets?", "exploit kits?", "crypters?", "fud crypters?", "0\\W?days?", "zero\\W?days?", "exploits?")} ${alt("for sale", "shops?", "market(?:place)?s?", "rent(?:al)?", "subscriptions?", "builders?", "panels?")}\\b`,
        "\\bbotnets? (?:for rent|for hire)\\b",
        `\\b${alt("hackear", "invadir", "clonar", "espionar", "rastrear", "hackeando", "invadindo")} ${alt("whatsapp", "instagram", "facebook", "celular", "telefone", "contas?", "e\\W?mail", "gmail", "icloud", "tiktok", "snapchat")}\\b`,
        // "hack/hacking X" is the attacker's phrasing; "hacked X" is usually a victim looking for help
        `\\bhack(?:ing)? ${alt("whatsapp", "instagram", "facebook", "snapchat", "gmail", "icloud", "tiktok", "someone'?s? (?:phone|account)")}\\b`,
        "\\baccount takeover services?\\b",
        "\\bsim\\W?swap(?:ping)? services?\\b",
        "\\b(?:stealer|infostealer|redline|raccoon|vidar|lumma) logs?\\b",
        "\\bcombo\\W?lists?\\b",
        "\\bcredential (?:dumps?|stuffing (?:tools?|services?))\\b",
        "\\bspy on (?:my |your |someone'?s? )?(?:wife|husband|girlfriend|boyfriend|partner|spouse)\\b",
        "\\bespionar (?:o |a )?(?:celular|whatsapp) (?:da|do) (?:esposa|marido|namorad(?:a|o))\\b"
      ),
      OPEN
    )
  ]
};

const extremism: Category = {
  id: "extremism",
  label: "Violent extremism",
  description: "Terrorist propaganda and recruitment, mass-shooter glorification.",
  locked: false,
  rules: [
    rule(
      alt(
        "\\b(?:isis|daesh|islamic state) (?:propaganda|recruit\\w*|videos?|magazines?|channels?)\\b",
        "\\bjihad\\w* (?:recruit\\w*|videos?|propaganda|magazines?|forums?)\\b",
        "\\bjoin (?:isis|daesh|the islamic state|al\\W?qaeda|al\\W?shabaab)\\b",
        "\\b(?:terrorist|terror) (?:manuals?|propaganda|recruitment|handbooks?|training)\\b",
        "\\b(?:mass\\W?shooter|shooter'?s?) manifestos?\\b",
        "\\b(?:neo\\W?nazi|white supremac\\w*|white power) (?:forums?|propaganda|recruit\\w*|music)\\b",
        "\\batomwaffen\\b",
        "\\bday of the rope\\b",
        "\\b(?:christchurch|buffalo) (?:shooting )?(?:video|livestream|manifesto)\\b",
        "\\b(?:school\\W?shooters?|atiradores?) (?:fandom|tcc|comunidade|idolos?|herois?)\\b"
      ),
      OPEN
    )
  ]
};

export const CATEGORIES: readonly Category[] = [
  csam,
  exploitation,
  massHarm,
  sexual,
  gore,
  violenceForHire,
  weapons,
  drugs,
  fraud,
  hacking,
  extremism
];
