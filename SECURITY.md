# Security policy

Deep Search fetches untrusted content from the web and the Tor network, so security reports are very welcome.

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue for security problems.

Useful details:

- the affected tool (`deepsearch_search`, `deepsearch_fetch_page`, `deepsearch_archived_versions`) and the exact input;
- what happened and what you expected;
- for remote-content issues, how the remote side behaves (redirects, headers, content type).

You can expect an acknowledgement within a few days. Fixes are released on the `main` branch.

## In scope

- Ways around the safety filter, especially its locked categories (`csam`, `exploitation`, `mass_harm`) and Ahmia's blacklist of banned onion services.
- SSRF: reaching `localhost`, private networks or cloud metadata endpoints.
- Tor deanonymization: DNS leaks, traffic leaving Tor, identifying headers.
- Leaks of API keys or other secrets.
- Crashes or resource exhaustion caused by crafted input or remote content.

## Out of scope

- Content of third-party search results or pages (report abusive onion services to [Ahmia](https://ahmia.fi)).
- Rate limits or availability of the upstream services.
