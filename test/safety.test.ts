import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { HttpClient } from "../src/http/client.js";
import { BannedOnionList, md5, onionHashCandidates, parseBannedList } from "../src/safety/banned.js";
import { SafetyGuard } from "../src/safety/guard.js";
import { leetVariant, normalizeText } from "../src/safety/normalize.js";
import { CATEGORIES } from "../src/safety/rules.js";
import type { Channel } from "../src/types.js";

const guard = new SafetyGuard();

describe("normalization", () => {
  it("lowercases, strips accents and URL separators", () => {
    expect(normalizeText("Criança_NUA")).toBe("crianca nua");
    expect(normalizeText("child%20porn")).toBe("child porn");
    expect(normalizeText("  Ação  \n Já ")).toBe("acao ja");
  });

  it("decodes leetspeak only next to letters", () => {
    expect(leetVariant("p0rn in 2016")).toBe("porn in 2016");
    expect(leetVariant("r@ygold")).toBe("raygold");
  });
});

describe("csam (locked)", () => {
  it.each([
    "pthc",
    "p.t.h.c videos",
    "child porn",
    "kiddie p0rn",
    "cp links onion",
    "teen nudes",
    "novinhas peladas",
    "pornografia infantil",
    "12yo nude",
    "jailbait pics",
    "детское порно"
  ])("refuses web and dark web searches for %j (academic stays allowed)", query => {
    const refused = guard.checkQuery(query);
    expect(refused.get("web")).toBe("csam");
    expect(refused.get("darkweb")).toBe("csam");
    expect(refused.has("academic")).toBe(false);
  });

  it.each(["pedofilia", "child sexual abuse", "csam detection", "crianca abuso"])(
    "refuses only the dark web for topic query %j",
    query => {
      const refused = guard.checkQuery(query);
      expect(refused.get("darkweb")).toBe("csam");
      expect(refused.has("web")).toBe(false);
      expect(refused.has("academic")).toBe(false);
    }
  );

  it("hides trade slang even in academic metadata", () => {
    expect(guard.classify("pthc keyword", "academic")).toBe("csam");
  });

  it("keeps scholarly work and child-protection pages", () => {
    expect(guard.classify("Child pornography offenders: a systematic review", "academic")).toBeNull();
    expect(guard.classify("Child abuse hotline — report suspected abuse", "web")).toBeNull();
  });

  it("hides child-abuse topics on the dark web", () => {
    expect(guard.classify("child abuse forum", "darkweb")).toBe("csam");
  });
});

describe("mass harm (locked)", () => {
  it.each(["how to make a pipe bomb", "como fazer uma bomba caseira", "sarin synthesis", "TATP recipe", "anarchist cookbook pdf"])(
    "refuses %j on web and dark web",
    query => {
      const refused = guard.checkQuery(query);
      expect(refused.get("web")).toBe("mass_harm");
      expect(refused.get("darkweb")).toBe("mass_harm");
      expect(refused.has("academic")).toBe(false);
    }
  );
});

describe("exploitation (locked)", () => {
  it("hides non-consensual intimate content on the open web", () => {
    expect(guard.classify("OnlyFans leaks mega folder", "web")).toBe("exploitation");
    expect(guard.classify("nudes vazados da ex", "web")).toBe("exploitation");
    expect(guard.classify("deepfake porn generator", "web")).toBe("exploitation");
  });

  it("refuses trafficking searches on the dark web only", () => {
    const refused = guard.checkQuery("human trafficking");
    expect(refused.get("darkweb")).toBe("exploitation");
    expect(refused.has("web")).toBe(false);
  });
});

describe("configurable categories", () => {
  it.each([
    ["free porn videos", "sexual"],
    ["real gore videos", "gore"],
    ["hire a hitman", "violence_for_hire"],
    ["buy glock online", "weapons"],
    ["guns for sale", "weapons"],
    ["buy cocaine online", "drugs"],
    ["comprar maconha", "drugs"],
    ["fresh cvv shop", "fraud"],
    ["fake passports for sale", "fraud"],
    ["painel de consulta", "fraud"],
    ["hacker for hire", "hacking_services"],
    ["hackear whatsapp", "hacking_services"],
    ["isis propaganda videos", "extremism"]
  ])("hides %j as %s on the web", (text, category) => {
    expect(guard.classify(text, "web")).toBe(category);
    expect(guard.classify(text, "darkweb")).toBe(category);
  });

  it("does not refuse the query itself (only listings are hidden)", () => {
    expect(guard.checkQuery("buy cocaine").size).toBe(0);
    expect(guard.checkQuery("darknet drug markets research").size).toBe(0);
  });

  it("never applies to academic metadata", () => {
    expect(guard.classify("Buy cocaine online: a study of darknet vendors", "academic")).toBeNull();
  });

  it("can be disabled by configuration", () => {
    const relaxed = new SafetyGuard(["drugs", "FRAUD"]);
    expect(relaxed.classify("buy cocaine online", "web")).toBeNull();
    expect(relaxed.classify("fresh cvv shop", "web")).toBeNull();
    expect(relaxed.classify("free porn videos", "web")).toBe("sexual");
    expect(relaxed.disabled.sort()).toEqual(["drugs", "fraud"]);
  });

  it("ignores attempts to disable locked or unknown categories", () => {
    const attempt = new SafetyGuard(["csam", "mass_harm", "exploitation", "nonsense"]);
    expect(attempt.disabled).toEqual([]);
    expect(attempt.ignored).toHaveLength(4);
    expect(attempt.checkQuery("child porn").get("web")).toBe("csam");
    expect(attempt.policy().filter(p => p.locked).every(p => p.enabled)).toBe(true);
  });
});

describe("false positives that must pass", () => {
  it.each<[string, Channel]>([
    ["dengue vaccine efficacy", "web"],
    ["cp command linux tutorial", "darkweb"],
    ["Lolita by Vladimir Nabokov", "web"],
    ["deep thc extraction", "web"],
    ["how to make a bath bomb", "web"],
    ["como fazer bomba de agua caseira", "web"],
    ["Al Gore climate videos", "web"],
    ["Gore-Tex jacket review", "web"],
    ["weed killer for sale", "web"],
    ["Track 1 - Opening theme", "web"],
    ["Raas Garba festival", "web"],
    ["Citroen C4 for sale", "web"],
    ["pipe organs for sale", "web"],
    ["drug delivery systems with nanoparticles", "web"],
    ["in order to ban guns", "web"],
    ["torpedo and speedo", "darkweb"],
    ["Shota Imanaga pitching stats", "web"],
    ["Ford Escort parts", "web"],
    ["wool carding machine", "web"],
    ["children's books for sale", "web"],
    ["sell kids clothes", "web"],
    ["teen pregnancy statistics", "web"],
    ["how to build a bomb shelter", "web"],
    ["How to recover a hacked Instagram account", "web"],
    ["Privacy guides for journalists", "darkweb"]
  ])("allows %j on %s", (text, channel) => {
    expect(guard.classify(text, channel)).toBeNull();
  });

  it.each(["how to make a bath bomb", "dengue vaccine", "child abuse hotline", "deep web academic databases", "ransomware leak sites"])(
    "does not refuse the query %j on the open web",
    query => {
      expect(guard.checkQuery(query).has("web")).toBe(false);
    }
  );
});

describe("document screening", () => {
  it("lets through a page that mentions a topic once", () => {
    const news = "Police said the suspects used the site to buy cocaine. The investigation continues next week.";
    expect(guard.checkDocument(news, "web").category).toBeNull();
  });

  it("withholds a page that repeatedly sells drugs", () => {
    const shop = "Buy cocaine online. Cheap MDMA, fast shipping. Buy heroin with bitcoin. Best prices.";
    const verdict = guard.checkDocument(shop, "web");
    expect(verdict.category).toBe("drugs");
    expect(verdict.hits.drugs).toBeGreaterThanOrEqual(3);
  });

  it("withholds a page on a single hit of a locked category", () => {
    expect(guard.checkDocument("Welcome. Free teen nudes gallery updated daily.", "web").category).toBe("csam");
  });
});

describe("Ahmia banned list", () => {
  const http = new HttpClient(loadConfig({}).config);

  it("parses one MD5 per line and ignores junk", () => {
    const set = parseBannedList(`${md5("a.onion")}\n  ${md5("b.onion").toUpperCase()}  \nnot-a-hash\n`);
    expect(set.size).toBe(2);
  });

  it("matches hosts with and without subdomain or .onion suffix", () => {
    const candidates = onionHashCandidates("sub.example.onion");
    expect(candidates).toContain(md5("example.onion"));
    expect(candidates).toContain(md5("example"));
    const list = BannedOnionList.fromHashes(http, [md5("bad.onion")]);
    expect(list.isBanned("BAD.onion")).toBe(true);
    expect(list.isBanned("x.bad.onion")).toBe(true);
    expect(list.isBanned("good.onion")).toBe(false);
  });
});

describe("rule hygiene", () => {
  it("compiles every rule and exposes 11 categories with 3 locked", () => {
    expect(CATEGORIES).toHaveLength(11);
    expect(CATEGORIES.filter(c => c.locked).map(c => c.id)).toEqual(["csam", "exploitation", "mass_harm"]);
    for (const category of CATEGORIES) {
      expect(category.rules.length).toBeGreaterThan(0);
      for (const rule of category.rules) expect(() => rule.re.test("sample text")).not.toThrow();
    }
  });

  it("screens a large document quickly", () => {
    const big = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(8000);
    const start = performance.now();
    guard.checkDocument(big, "darkweb");
    expect(performance.now() - start).toBeLessThan(2500);
  });
});
