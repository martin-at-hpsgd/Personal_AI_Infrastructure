# Tool Catalog

Tool names and availability can change. Discover live schemas through MCP; this catalog intentionally contains no argument schemas.

## Free

| Tool | Purpose |
|---|---|
| `search_companies` | Search cybersecurity companies. |
| `enrich_company` | Retrieve an enriched company record. |
| `get_market_overview` | Summarize the cybersecurity market. |
| `get_category_momentum` | Retrieve category momentum metrics. |
| `get_investor_centrality` | Measure investor network centrality. |
| `get_investor_tiers` | Retrieve investor tier classifications. |
| `get_data_status` | Check dataset status, coverage, and freshness. |
| `list_categories` | List supported taxonomy categories. |
| `list_countries` | List supported country filters. |
| `get_entity_transitions` | Retrieve entity lifecycle transitions. |
| `get_company_ipo` | Retrieve company IPO information. |
| `get_company_public_lifecycle` | Retrieve public-company lifecycle events. |

## Pro

| Tool | Purpose |
|---|---|
| `search_investors` | Search investors. |
| `get_investor_portfolio` | Retrieve an investor's portfolio. |
| `get_funding_rounds` | Retrieve funding-round records. |
| `get_ma_activity` | Retrieve merger and acquisition activity. |
| `find_connections` | Find relationships between market entities. |
| `suggest_acquirers` | Generate analytical acquirer suggestions. |
| `search_growth_signals` | Search company growth signals. |
| `get_funding_timeseries` | Retrieve funding over time. |
| `compare_periods` | Compare market periods. |
| `forecast_funding` | Generate an analytical funding forecast. |
| `get_valuation_trends` | Retrieve valuation trends. |
| `get_round_velocity` | Measure funding-round velocity. |
| `category_consolidation_signals` | Retrieve analytical category-consolidation signals. |
| `get_acquirer_empire` | Map an acquirer's portfolio of acquisitions. |
| `find_similar_companies` | Find comparable cybersecurity companies. |
| `get_cross_border_flows` | Retrieve cross-border capital or deal flows. |
| `get_company_partnerships` | Retrieve company partnerships. |
| `compare_partnership_overlap` | Compare partnership overlap. |
| `find_partnership_cohort` | Find companies sharing partnership patterns. |
| `get_company_layoffs` | Retrieve company layoff records. |
| `get_company_shutdown` | Retrieve company shutdown records. |

## Enterprise

| Tool | Purpose |
|---|---|
| `reconcile_companies` | Reconcile company identities and records. |

## Methodology

The dataset curates global cybersecurity funding, M&A, layoffs, shutdowns, and public-company lifecycle events from press releases, SEC filings, company announcements, and verified reporting. It does not use paywalled databases or aggregators.

Its proprietary taxonomy separates category domains from product categories and supplements them with metadata tags.

## REST Fallback

- Base: `https://signal.returnonsecurity.com`
- Surface: 18 read-only `GET /api/v2/*` endpoints
- Authentication: HTTP Bearer authentication sourced from the ROS_API_KEY environment variable.
- Metadata: preserve `X-Data-Freshness`, quota, and request-ID headers
- Access: Pro/Team add-on or Enterprise

## Sources

- https://mcp.returnonsecurity.com/
- https://mcp.returnonsecurity.com/mcp
- https://docs.returnonsecurity.com/
- https://docs.returnonsecurity.com/reference/
- https://www.returnonsecurity.com/data-methodology
- https://signal.returnonsecurity.com/
