# Decision Log — Skylark Drones BI Agent

## Key Assumptions

1. **Data is read-only.** The assignment says Monday.com integration is read-only, so no writes or mutations are performed.

2. **GraphQL over MCP.** I chose Monday.com's REST/GraphQL API over MCP because it requires no additional server-side MCP tooling, works natively in Next.js API routes, and is simpler to host on Vercel. The API is well-documented and stable.

3. **Gemini Flash as the LLM.** Using `gemini-1.5-flash` — it has a generous free tier, supports long context windows (needed for injecting full board data), and streams responses. This is ideal for a prototype that must be testable without setup.

4. **Data injection (RAG-lite) over function calling.** I chose to inject the full cleaned board data into the system prompt rather than using LLM function calling to fetch data mid-conversation. Rationale: the boards have ~100–500 records, which fits comfortably in Flash's 1M context window, and this approach gives the LLM full context for cross-board analysis without multiple round-trips.

5. **"Messy data" handling.** I assumed the data contains: inconsistent date formats (DD/MM/YYYY vs ISO vs written-out months), varying currency representations (₹1,00,000 vs 1L vs 100000), sector names in different cases/abbreviations, and missing values. The cleaning layer handles all of these gracefully.

6. **No user authentication.** The prototype is a single-user demo. A production version would add OAuth / API key per-tenant.

---

## Trade-offs Chosen and Why

| Decision | Alternative Considered | Why I Chose This |
|---|---|---|
| Next.js (full-stack) | Separate Express backend + React frontend | Simpler deployment on Vercel with a single repo |
| Gemini Flash | GPT-4o, Claude | Free tier, no credit card, adequate quality for BI |
| Full data injection | LLM function calling | Fewer API round-trips, simpler, works for prototype scale |
| GraphQL API | Monday.com MCP | No MCP server setup needed; deploys on Vercel |
| Streaming responses | Batch response | Better UX for long BI answers; shows progress |
| Vanilla CSS | Tailwind CSS | More control over premium glassmorphism design |

---

## What I'd Do Differently With More Time

1. **Semantic caching** — Cache board data for 5 minutes to reduce Monday.com API calls on repeated similar queries.
2. **LLM function calling** — Let the LLM decide exactly which columns/filters to query rather than fetching everything. This would scale better for boards with thousands of items.
3. **Chart generation** — Use Recharts or Chart.js to render bar/line charts for pipeline trends instead of markdown tables.
4. **Webhook sync** — Subscribe to Monday.com webhooks to keep a local cache always fresh, enabling sub-second query response.
5. **Multi-tenancy** — Per-workspace API key management so multiple teams can use the agent.
6. **Conversation memory** — Persist conversation history across sessions using a database (Postgres/Supabase).

---

## How I Interpreted "Leadership Updates"

The requirement says: *"The agent should help prepare data for leadership updates."*

**My interpretation:** When a user asks for a "leadership update" or "board update" or "executive summary," the agent generates a structured briefing document suitable for pasting into a presentation or sending as a weekly update email.

**Format produced:**
- 📊 **Pipeline Health** — Total pipeline value, deals by stage, sector breakdown
- ✅ **Operational Wins** — Completed work orders this month, revenue recognized
- ⚠️ **At-Risk Items** — Stalled deals (no movement in 30+ days), overdue work orders
- 🎯 **Key Metrics** — Win rate, average deal size, average project duration
- 📋 **Action Items** — Specific deals/orders needing attention

This framing treats the agent as a "chief of staff" that surfaces the right information for a board-level conversation without requiring manual data pulls.
