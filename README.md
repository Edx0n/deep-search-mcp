# deep-search-mcp

Servidor **MCP** (Model Context Protocol) para pesquisa além do Google: bases acadêmicas, dados abertos, arquivos digitais, buscadores independentes e a **dark web (rede Tor)**, com **filtros de segurança** sempre ativos.

A ideia é encontrar o que os buscadores comerciais enterram ou nunca indexam: artigos e teses em repositórios, literatura cinzenta, sites pequenos e independentes, páginas removidas (via Wayback Machine) e serviços `.onion`, sem expor o usuário a conteúdo impróprio.

---

## Ferramentas

| Ferramenta | O que faz |
|---|---|
| `deepsearch_search` | Meta-busca em até 17 fontes, agrupadas em 5 escopos (`academic`, `data`, `archive`, `web`, `darkweb`). Resultados agrupados por fonte, com DOI, PDF de acesso aberto, autores, ano e status de cada fonte. Remove duplicatas entre fontes. |
| `deepsearch_fetch_page` | Lê uma página e devolve o texto limpo: HTML, **PDF**, `.onion` (via Tor) ou snapshot da Wayback Machine. Páginas longas são paginadas (`start_char`). Lista os links da página, também filtrados. |
| `deepsearch_archived_versions` | Lista as capturas da **Wayback Machine** de uma URL, caminho ou domínio, para recuperar conteúdo apagado ou alterado. |
| `deepsearch_list_sources` | Mostra as fontes, o que cada uma precisa (chave, Tor), o status do Tor e a política de segurança ativa. |

Também há um *prompt* MCP, `deepsearch_investigate`, que conduz uma investigação completa: busca em todos os escopos, leitura das fontes, checagem cruzada e relatório com citações.

## Fontes

| Escopo | Fonte | O que traz | Precisa de |
|---|---|---|---|
| academic | **OpenAlex** | ~250 mi de trabalhos acadêmicos, com links de acesso aberto | nada (chave opcional) |
| academic | **CORE** | ~300 mi de artigos de repositórios institucionais; acha a versão gratuita de artigos pagos | nada (chave grátis evita limite) |
| academic | **Crossref** | Metadados de ~170 mi de DOIs (inclui SSRN, capítulos, relatórios) | nada |
| academic | **SciELO** | Periódicos brasileiros e latino-americanos | nada |
| academic | **Europe PMC** | Saúde e ciências da vida (todo o PubMed/MEDLINE + PMC) | nada |
| academic | **arXiv** | Pré-prints de física, matemática, computação, economia... | nada |
| academic | **DOAJ** | Periódicos 100% acesso aberto | nada |
| academic | **BDTD (IBICT)** | Teses e dissertações de universidades brasileiras | nada |
| academic | Semantic Scholar | Busca acadêmica com contagem de citações | chave (sob demanda sem chave) |
| data | **DataCite** | Datasets com DOI (Zenodo, Figshare, Dryad, Dataverse...) | nada |
| data | **Zenodo** | Datasets, software, relatórios e outra literatura cinzenta | nada |
| archive | **Internet Archive** | Livros digitalizados, documentos, revistas, áudio e vídeo | nada |
| web | **Marginalia** | Índice próprio que privilegia sites pequenos e não comerciais | nada (chave pública costuma estar no limite) |
| web | **Wiby** | A web "clássica": páginas pessoais e leves | nada |
| web | **DuckDuckGo** | Busca geral sem Google (apenas a 1ª página) | nada |
| web | Brave Search | Índice independente (nem Google, nem Bing) | `BRAVE_API_KEY` |
| darkweb | **Ahmia** | Índice de serviços `.onion` que remove conteúdo de abuso | nada (Tor opcional) |

Em **negrito**: fontes que rodam por padrão. As demais rodam quando têm chave ou quando pedidas explicitamente no parâmetro `sources`.

## Segurança

O filtro é uma parte central do projeto e **não pode ser desligado por completo**.

**Categorias travadas** (nenhuma configuração as desativa):

- `csam`: abuso sexual infantil. A consulta é **recusada** na web e na dark web, e os resultados são sempre ocultados.
- `exploitation`: tráfico humano/de órgãos, escravidão sexual, imagens íntimas vazadas ou não consentidas, *deepfake nudes*.
- `mass_harm`: instruções para bombas, explosivos e armas químicas/biológicas. A consulta é recusada.

**Categorias configuráveis** (ligadas por padrão): `sexual`, `gore`, `violence_for_hire`, `weapons`, `drugs`, `fraud`, `hacking_services`, `extremism`. Elas miram **anúncios e transações** ("buy cocaine", "guns for sale", "hacker for hire"), não temas. Notícias e pesquisas sobre esses assuntos continuam aparecendo.

Como funciona:

- **Canais**: cada fonte tem um canal. O `academic` (metadados acadêmicos e páginas de editoras e repositórios científicos) só aplica as gírias inequívocas de abuso, para que pesquisas *sobre* esses temas continuem acessíveis. O `web` e o `darkweb` aplicam tudo.
- **Lista negra do Ahmia**: os ~60 mil domínios `.onion` banidos pelo Ahmia por abuso são removidos dos resultados e **nunca são abertos**. Se a lista não puder ser carregada, páginas `.onion` não são abertas (*fail-closed*).
- **Leitura de páginas**: só texto (nada de imagens, vídeos ou downloads). Uma página dominada por conteúdo filtrado é retida e o texto não é devolvido.
- **Proteção contra SSRF**: endereços locais e privados (`localhost`, `192.168.x.x`, metadados de nuvem...) são recusados, inclusive após redirecionamentos.
- **Transparência**: o cliente se identifica como `deep-search-mcp` na clear web. **Não resolve nem contorna CAPTCHAs** ou verificações anti-bot: quando uma fonte pede, isso é reportado. Via Tor, usa o User-Agent do Tor Browser, para ficar no mesmo conjunto de anonimato.

Os filtros são heurísticos: reduzem muito a exposição, mas não são perfeitos. Use com responsabilidade e de acordo com a lei.

## Instalação

Requer **Node.js 20.18+**.

```bash
git clone https://github.com/Edx0n/deep-search-mcp.git
cd deep-search-mcp
npm install
npm run build
```

### Claude Code

```bash
claude mcp add deep-search -- node X:/PROJETOS/deep-search-mcp/dist/index.js
```

Com variáveis de ambiente (exemplo com Tor):

```bash
claude mcp add deep-search -e DEEP_SEARCH_TOR_PROXY=socks5h://127.0.0.1:9150 -- node X:/PROJETOS/deep-search-mcp/dist/index.js
```

### Claude Desktop

Em `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "deep-search": {
      "command": "node",
      "args": ["X:\\PROJETOS\\deep-search-mcp\\dist\\index.js"],
      "env": {
        "DEEP_SEARCH_TOR_PROXY": "socks5h://127.0.0.1:9150"
      }
    }
  }
}
```

## Configuração

Todas as variáveis são opcionais (veja [`.env.example`](.env.example)).

| Variável | Para quê |
|---|---|
| `DEEP_SEARCH_TOR_PROXY` | Proxy SOCKS5 do Tor, ex.: `socks5h://127.0.0.1:9150` (Tor Browser) ou `:9050` (serviço tor). Necessário para **abrir** páginas `.onion`. |
| `DEEP_SEARCH_AHMIA_MODE` | `auto` (padrão: usa o espelho `.onion` do Ahmia quando há Tor), `clearnet` ou `onion`. |
| `DEEP_SEARCH_DISABLED_FILTERS` | Categorias **configuráveis** a desligar, ex.: `drugs,fraud` (útil para *threat intelligence*). Categorias travadas são ignoradas. |
| `OPENALEX_API_KEY` | Chave grátis do OpenAlex (sem ela há uma cota diária compartilhada por IP). |
| `CORE_API_KEY` | Chave grátis do CORE (sem ela o limite anônimo é baixo). |
| `SEMANTIC_SCHOLAR_API_KEY` | Ativa o Semantic Scholar por padrão. |
| `MARGINALIA_API_KEY` | Chave pessoal grátis do Marginalia (pedida por e-mail); a pública vive no limite. |
| `BRAVE_API_KEY` | Ativa o Brave Search. |
| `DEEP_SEARCH_CONTACT_EMAIL` | E-mail para o *polite pool* do Crossref/OpenAlex. Só é enviado se você definir. |
| `DEEP_SEARCH_TIMEOUT_MS` / `DEEP_SEARCH_TOR_TIMEOUT_MS` | Timeouts (padrão 20 s / 60 s). |

### Tor (opcional)

A **busca** na dark web funciona sem Tor (via `ahmia.fi`). O Tor é necessário para **ler** páginas `.onion` e para buscar pelo espelho `.onion` do Ahmia.

- **Tor Browser**: abra o navegador e deixe-o aberto. O proxy fica em `socks5h://127.0.0.1:9150`.
- **Serviço tor (Tor Expert Bundle)**: baixe em torproject.org, rode o `tor.exe`, e o proxy fica em `socks5h://127.0.0.1:9050`.

Use `socks5h` para que os nomes `.onion` sejam resolvidos pelo Tor, não pelo seu DNS.

## Exemplos de uso

Peça ao Claude, em linguagem natural:

- "Use o deep search para levantar estudos sobre glifosato e câncer desde 2015, incluindo teses brasileiras."
- "Procure na dark web o que se fala sobre o grupo de ransomware X e resuma, marcando o que não é verificável."
- "Essa página do governo saiu do ar: veja as versões arquivadas e o que mudou."
- "Ache blogs independentes sobre a história da computação no Brasil, excluindo a Wikipedia."
- `/deepsearch_investigate` com um tema, para a investigação guiada completa.

## Desenvolvimento

```bash
npm test
```

```bash
npm run build && npm run smoke
```

```bash
npm run live -- "termo de busca"
```

- `npm test`: testes unitários (filtros, parsers, cliente HTTP com SOCKS simulado, orquestrador e formatação), sem rede.
- `npm run smoke`: teste ponta a ponta. Sobe o servidor via stdio e chama todas as ferramentas contra os serviços reais.
- `npm run live`: roda cada fonte uma vez e mostra status, contagem e tempo.

Estrutura: [`docs/DESIGN.md`](docs/DESIGN.md).

## Limitações conhecidas

- **Limites de taxa**: Semantic Scholar e a chave pública do Marginalia vivem no limite. CORE anônimo e Crossref (1 req/s, já respeitado com uma fila) também têm cotas. Chaves gratuitas resolvem.
- **DuckDuckGo**: só a primeira página. Pode pedir verificação anti-bot; nesse caso a fonte aparece com erro e as demais seguem.
- **Ahmia**: buscas amplas retornam milhares de resultados e levam ~10 s. Serviços `.onion` costumam ser lentos ou sair do ar.
- **Filtro**: páginas da web aberta *sobre* abuso infantil (notícias, enciclopédias) também são retidas. Para pesquisar o tema, use o escopo `academic`.
- **PDFs escaneados** sem camada de texto (sem OCR) não têm o que extrair.

### Sobre outras fontes pesquisadas

- **Torch, Haystak e similares** não foram incluídos. Os endereços conhecidos do Torch são v2 (desativados desde 2021), o do Haystak circula em formato inválido e, principalmente, esses índices **não filtram conteúdo de abuso**. O Ahmia é o único com lista negra mantida.
- **BASE** exige cadastro do IP para usar a API.
- **OATD**, a busca do **SciELO** e o **Internet Archive Scholar** bloqueiam acesso automatizado. O SciELO entra via Crossref.
- **Mojeek** responde com CAPTCHA para acesso automatizado e não é contornado.

## Uso responsável

Ferramenta para pesquisa, jornalismo e OSINT. Acessar a dark web pode ser legal na sua jurisdição, mas o conteúdo que você abre e o que faz com ele são sua responsabilidade. Não use este projeto para obter, distribuir ou facilitar conteúdo ou atividades ilegais.
