import type { Scope, Source, SourceId } from "../types.js";
import { arxiv } from "./academic/arxiv.js";
import { bdtd } from "./academic/bdtd.js";
import { core } from "./academic/core.js";
import { crossref, scielo } from "./academic/crossref.js";
import { doaj } from "./academic/doaj.js";
import { europepmc } from "./academic/europepmc.js";
import { openalex } from "./academic/openalex.js";
import { semanticScholar } from "./academic/semanticscholar.js";
import { internetArchive } from "./archive.js";
import { ahmia } from "./darkweb.js";
import { datacite, zenodo } from "./data.js";
import { brave, duckduckgo, marginalia, wiby } from "./web.js";

/** Every source, in display order (scope by scope). */
export const SOURCES: readonly Source[] = [
  openalex,
  core,
  crossref,
  scielo,
  europepmc,
  arxiv,
  doaj,
  bdtd,
  semanticScholar,
  datacite,
  zenodo,
  internetArchive,
  marginalia,
  wiby,
  duckduckgo,
  brave,
  ahmia
];

export const SCOPE_LABELS: Record<Scope, string> = {
  academic: "Academic literature",
  data: "Open data & research outputs",
  archive: "Archives & libraries",
  web: "Independent web search (no Google)",
  darkweb: "Dark web (Tor onion services)"
};

export function getSource(id: SourceId): Source | undefined {
  return SOURCES.find(s => s.id === id);
}
