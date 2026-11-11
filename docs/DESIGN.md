# Design do deep-search-mcp

## Objetivo

Dar a um assistente (via MCP) acesso a fontes que buscadores comerciais enterram ou não indexam: literatura acadêmica e cinzenta, dados abertos, arquivos digitais, índices independentes e serviços `.onion`. Tudo com um filtro de segurança que o usuário não consegue desligar por inteiro.

**Critérios de sucesso**

- Uma única chamada (`deepsearch_search`) cobre todos os escopos. Falhas de uma fonte não derrubam a busca.
- Resultados citáveis (URL, DOI, PDF aberto) e paginação previsível.
- Conteúdo de abuso nunca é mostrado. Pesquisa legítima *sobre* temas sensíveis continua possível.
- Nada de contornar CAPTCHAs ou bloqueios anti-bot. O cliente se identifica honestamente.

## Arquitetura

```
src/
├── index.ts              entrada stdio (logs só em stderr)
├── server.ts             createRuntime() + createServer(): 4 ferramentas + 1 prompt (SDK MCP v2, Zod 4)
├── config.ts             variáveis de ambiente → Config
├── search.ts             orquestrador: seleção de fontes, recusa por canal, execução paralela,
│                         filtro, dedupe, paginação
├── format.ts             Markdown/JSON, limite de 25 mil caracteres (corta itens, não texto)
├── cache.ts              cache TTL em memória (10 min)
├── http/
│   ├── client.ts         undici.request: só os headers que definimos, redirects revalidados,
│   │                     limite de bytes, Tor via SOCKS5 (fetch-socks)
│   └── ssrf.ts           bloqueio de IPs privados (no DNS lookup, na hora da conexão)
├── safety/
│   ├── rules.ts          11 categorias, regras por canal e de recusa de consulta
│   ├── normalize.ts      minúsculas, sem acentos, leetspeak, separadores de URL
│   ├── guard.ts          checkQuery / classify / checkDocument
│   ├── banned.ts         lista negra MD5 do Ahmia (cache em disco por 24 h)
│   └── scholarly.ts      hosts acadêmicos (páginas avaliadas com regras acadêmicas)
├── sources/              uma fonte = parser puro (testável) + search() com a chamada HTTP
│   ├── academic/         openalex, core, crossref (+ scielo), europepmc, arxiv, doaj,
│   │                     semanticscholar, bdtd
│   ├── data.ts           datacite, zenodo
│   ├── archive.ts        internet archive
│   ├── web.ts            marginalia, wiby, duckduckgo, brave
│   ├── darkweb.ts        ahmia (clearnet ou espelho .onion)
│   └── registry.ts       ordem de exibição e rótulos dos escopos
├── extract/              HTML → texto estruturado + links; PDF → texto (unpdf)
└── tools/                lógica de deepsearch_fetch_page e deepsearch_archived_versions
```

## Fluxo de uma busca

1. **Seleção**: `sources` explícitas ou as fontes padrão dos `scopes` (todos, por padrão).
2. **Recusa por canal**: `guard.checkQuery()` devolve os canais em que a consulta não pode rodar. Se todos os canais pedidos forem recusados, a ferramenta retorna erro com a explicação.
3. **Execução paralela**: cada fonte tem o próprio timeout; erros viram status `error` no relatório da fonte.
4. **Pós-processamento por fonte**: filtro de ano (as fontes que suportam filtram no servidor; para as outras, é uma rede de segurança), `exclude_domains`, lista negra do Ahmia e `guard.classify()`. O que é ocultado é contado por motivo, sem mostrar o conteúdo.
5. **Paginação**:
   - Fontes paginadas no servidor recebem `offset` e `limit`. As baseadas em página usam `pageWindow()`.
   - O Ahmia devolve tudo numa página só (`complete: true`). Por isso o orquestrador filtra **antes** de paginar, para as páginas ficarem consistentes.
6. **Dedupe**: por DOI, ou por URL normalizada. A primeira ocorrência fica e ganha `also_in`.
7. **Formatação**: se passar de 25 mil caracteres, reduz o número de itens por fonte, aplicando o mesmo teto a todas. O `next_offset` continua correto.

## Modelo de segurança

| Canal | Fontes | Regras aplicadas |
|---|---|---|
| `academic` | metadados acadêmicos e páginas de hosts acadêmicos | só gírias inequívocas de abuso infantil |
| `web` | buscadores da web, Internet Archive, páginas da clear web | todas as categorias ativas |
| `darkweb` | Ahmia, páginas `.onion` | todas, mais regras de tópico (ex.: termos clínicos de abuso) e lista negra |

- **Consultas**: categorias travadas recusam a consulta nos canais abertos (`csam` explícito, `mass_harm`) ou só na dark web (termos de tópico, `exploitation`). Categorias configuráveis nunca recusam consultas, só ocultam anúncios.
- **Documentos** (`deepsearch_fetch_page`): uma ocorrência de categoria travada já retém a página. Categorias configuráveis precisam de 3 ocorrências, para que uma notícia que só menciona o assunto passe.
- **Regras miram transações, não temas**. "buy cocaine" é filtrado; "darknet drug markets research" não. Uma bateria de testes de falsos positivos protege casos como "bath bomb", "bomba d'água", "Al Gore", "drug delivery", "Lolita (Nabokov)", "cp command", "recover hacked Instagram account".
- **Lista negra do Ahmia**: MD5 do domínio `.onion` (mesmo cálculo do código do Ahmia). Para abrir `.onion`, a lista precisa estar carregada (*fail-closed*).

## Decisões e alternativas descartadas

- **Só o Ahmia na dark web**: é o único índice com remoção ativa de abuso. Torch, Haystak e outros não filtram, e os endereços conhecidos estavam desatualizados.
- **`undici.request` em vez de `fetch`**: o `fetch` injeta headers de navegador (`sec-fetch-mode`...). Com eles, o DuckDuckGo tratava o cliente como bot disfarçado; com uma requisição simples e honesta, responde normalmente.
- **User-Agent**: honesto (`deep-search-mcp/x.y`) na clear web. O do Tor Browser só via Tor, pelo conjunto de anonimato.
- **Crossref com fila serial (1 req/s)**: o pool público anuncia `x-rate-limit-limit: 1` e `x-concurrency-limit: 1`. Crossref e SciELO compartilham a fila e fazem 1 nova tentativa após 429.
- **SciELO via Crossref (membro 530)**: a busca do SciELO bloqueia automação; o Crossref cobre os mesmos DOIs.
- **Semantic Scholar e Brave sob demanda**: sem chave, um vive em 429 e o outro não funciona. O Marginalia roda por padrão porque, quando funciona, é a fonte mais "anti-favoritismo".
- **E-mail do usuário nunca é enviado** às APIs. O *polite pool* só é usado se `DEEP_SEARCH_CONTACT_EMAIL` for definido.

## Testes

- `npm test` (sem rede):
  - regras de segurança: positivos, falsos positivos, desligamento e travas;
  - parsers de todas as fontes, com fixtures sintéticas;
  - cliente HTTP: SSRF, proxy SOCKS5 simulado (verifica que o nome `.onion` vai para o proxy), redirects e limite de bytes;
  - extração de HTML, orquestrador com fontes falsas (dedupe, paginação pós-filtro, recusas, falhas isoladas) e limite de caracteres.
- `npm run smoke`: cliente MCP real via stdio contra os serviços reais: busca acadêmica e na dark web, recusas, HTML, PDF do arXiv, SSRF, Wayback e validação de entrada.
- `npm run live`: diagnóstico fonte a fonte.
