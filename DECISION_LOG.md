# Decision Log — Skylark Drones BI Agent

## Key Assumptions

1. **Read-only access.** No writes to Monday.com — only GraphQL reads.
2. **GraphQL API over MCP.** Monday.com's native GraphQL API works directly in Next.js API routes on Vercel without extra server tooling. MCP would require a separate long-running process incompatible with Vercel's serverless model.
3. **Gemini Flash as LLM.** `gemini-3.5-flash` — generous free tier, long context window (needed for injecting structured board data), streams responses natively.
4. **Data injection (RAG-lite) over function calling.** The boards have ~100–500 records that fit in Gemini's context window. Injecting pre-aggregated summaries + filtered record lists gives the LLM full context for cross-board analysis in a single API call, avoiding multiple round-trip latency.
5. **Messy data expected.** The cleaning layer handles: inconsistent date formats (ISO, DD/MM/YYYY, written-out months), currency representations (₹1,00,000 / 1L / 100000), sector/status values in different cases, typos ("BIlled"), and missing values. 42% of Work Orders have an empty "WO Status (billed)" field — resolved by falling back to the "Execution Status" column.
6. **Qualitative probability.** The Deals board uses "High / Medium / Low" rather than numeric probabilities. Mapped to 70% / 40% / 15% respectively for weighted pipeline calculations, documented transparently in responses.

---

## Trade-offs

| Decision | Alternative | Why this |
|---|---|---|
| Next.js full-stack | Separate Express + React | Single repo, one-click Vercel deploy |
| Gemini Flash | GPT-4o, Claude | Free tier, no credit card, sufficient for BI |
| Pre-aggregated prompt injection | LLM function calling | No extra API round-trips; simpler; works at prototype scale |
| GraphQL API | Monday.com MCP | No sidecar process; deploys on Vercel serverless |
| Streaming responses | Batch | Better UX for long reports; shows progress immediately |
| 5-min in-memory cache | No cache | Reduces Monday.com API quota usage on repeated queries |

---

## What I'd Do Differently With More Time

1. **Date-range filtering** — Add true "this quarter" / "this month" filtering by comparing `closeDate` / `startDate` against query-extracted date ranges.
2. **LLM function calling** — Let Gemini dynamically decide which columns to fetch rather than injecting everything, enabling scale to 10,000+ item boards.
3. **Chart rendering** — Recharts bar/line charts for pipeline trend and sector comparison instead of markdown tables.
4. **Webhook sync** — Subscribe to Monday.com webhooks to maintain a fresh local cache, enabling sub-100ms data access.
5. **Conversation memory** — Persist history across sessions using Postgres/Supabase.

---

## Interpretation of "Leadership Updates"

When a user asks for a "leadership update", "board update", or "executive summary", the agent generates a structured briefing suitable for pasting into a board deck or weekly email:

- **Pipeline Health** — Total pipeline value, stage funnel, top sectors
- **Operational Wins** — Completed work orders, revenue billed
- **At-Risk Items** — Stalled deals, overdue work orders
- **Key Metrics** — Win rate, average deal size, collection rate
- **Action Items** — Specific deals/orders needing attention

This treats the agent as a "chief of staff" that surfaces board-ready intelligence without manual data pulls.
