/**
 * Hosts of scholarly publishers, preprint servers and research repositories. Pages and PDFs served
 * from them are screened with the "academic" rules: research ABOUT abuse, trafficking or the dark web
 * must stay readable, and these hosts do not serve abusive material.
 */
const SCHOLARLY_DOMAINS = [
  // Preprints and open repositories
  "arxiv.org",
  "biorxiv.org",
  "medrxiv.org",
  "ssrn.com",
  "osf.io",
  "researchsquare.com",
  "preprints.org",
  "hal.science",
  "archives-ouvertes.fr",
  "zenodo.org",
  "figshare.com",
  "datadryad.org",
  "dataverse.harvard.edu",
  "core.ac.uk",
  "doaj.org",
  "openalex.org",
  "semanticscholar.org",
  "philpapers.org",
  "scholar.archive.org",
  "openreview.net",
  "aclanthology.org",
  "proceedings.mlr.press",
  "neurips.cc",
  "usenix.org",
  "ndss-symposium.org",
  // Biomedical
  "europepmc.org",
  "ebi.ac.uk",
  "ncbi.nlm.nih.gov",
  "nih.gov",
  "who.int",
  "bmj.com",
  "thelancet.com",
  "cell.com",
  "plos.org",
  "biomedcentral.com",
  // Latin America / Brazil
  "scielo.br",
  "scielo.org",
  "redalyc.org",
  "bdtd.ibict.br",
  "periodicos.capes.gov.br",
  // Publishers
  "doi.org",
  "jstor.org",
  "sciencedirect.com",
  "springer.com",
  "nature.com",
  "wiley.com",
  "tandfonline.com",
  "sagepub.com",
  "cambridge.org",
  "oup.com",
  "mdpi.com",
  "frontiersin.org",
  "ieee.org",
  "acm.org",
  "emerald.com",
  "degruyter.com",
  "iop.org",
  "aps.org",
  "pnas.org",
  "science.org",
  "annualreviews.org"
];

export function isScholarlyHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (SCHOLARLY_DOMAINS.some(d => host === d || host.endsWith(`.${d}`))) return true;
  // SciELO runs national mirrors: scielo.org.mx, scielo.cl, scielo.isciii.es, ...
  return host.split(".").includes("scielo");
}
