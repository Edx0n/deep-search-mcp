/**
 * Hosts of scholarly publishers, moderated preprint servers and research indexes. Pages and PDFs
 * served from them are screened with the "academic" rules: research ABOUT abuse, trafficking or the
 * dark web must stay readable, and these hosts do not serve abusive material. Open upload
 * repositories (Zenodo, Figshare, OSF, Dataverse) are deliberately NOT listed: anyone can post there.
 */
const SCHOLARLY_DOMAINS = [
  // Moderated preprint servers and open-access indexes
  "arxiv.org",
  "biorxiv.org",
  "medrxiv.org",
  "ssrn.com",
  "researchsquare.com",
  "preprints.org",
  "hal.science",
  "archives-ouvertes.fr",
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
  // Latin America / Brazil. SciELO national sites are listed one by one: matching any host that merely
  // contains a "scielo" label would let "scielo.<attacker>.nip.io" switch the strict rules off.
  "scielo.br",
  "scielo.org",
  "scielo.org.ar",
  "scielo.org.bo",
  "scielo.cl",
  "scielo.org.co",
  "scielo.sa.cr",
  "scielo.sld.cu",
  "scielo.senescyt.gob.ec",
  "scielo.org.mx",
  "scielo.iics.una.py",
  "scielo.org.pe",
  "scielo.pt",
  "scielo.mec.pt",
  "scielo.org.za",
  "scielo.isciii.es",
  "scielo.edu.uy",
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

/** Exact registered domains only (and their subdomains): never a label match anywhere in the host. */
export function isScholarlyHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return SCHOLARLY_DOMAINS.some(d => host === d || host.endsWith(`.${d}`));
}
