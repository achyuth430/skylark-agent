/**
 * BI Agent Core Logic
 * Orchestrates query understanding, clarification, date-range filtering,
 * Monday.com data fetching, and Gemini response generation.
 */

import { getWorkOrders, getDeals, itemToObject, RawBoardData } from "./monday";
import { cleanWorkOrder, cleanDeal, analyzeQuality, summarizeDeals, summarizeWorkOrders, formatCurrency } from "./dataClean";
import { GoogleGenerativeAI, Content } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

// ─── Types ────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "user" | "model";
  content: string;
}

interface DateRange {
  start: Date;
  end: Date;
  label: string;
}

// ─── Clarification Engine ─────────────────────────────────────────────────

// These signal that the user already specified a time period in prior messages
const TIME_RESOLVED_SIGNALS = [
  "q1", "q2", "q3", "q4",
  "all-time", "all time", "entire", "everything",
  "6 months", "six months", "3 months", "three months",
  "fy2025", "fy2026", "fy 2026",
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
  "current quarter", "last quarter", "full year",
];

// These trigger a clarifying question on the first occurrence
const TIME_AMBIGUOUS_TRIGGERS = [
  "this quarter", "last quarter", "this month", "last month",
  "recently", "recent", "latest",
];

/**
 * Returns a clarification prompt string if the query is time-ambiguous
 * and the user hasn't already resolved it in the conversation history.
 * Returns null if no clarification is needed.
 */
function needsClarification(query: string, history: ChatMessage[]): string | null {
  const q = query.toLowerCase();
  const isAmbiguous = TIME_AMBIGUOUS_TRIGGERS.some((k) => q.includes(k));
  if (!isAmbiguous) return null;

  // Check whether the user already answered this time-period question
  const recentContext = history
    .slice(-6)
    .map((m) => m.content.toLowerCase())
    .join(" ");
  const alreadyResolved = TIME_RESOLVED_SIGNALS.some((k) => recentContext.includes(k));
  if (alreadyResolved) return null;

  return `To give you the most accurate answer, could you clarify the **time period** you have in mind?

**Please choose one:**

| Option | Period |
|---|---|
| 📅 **Current Quarter** | Q2 FY2026 (July – September 2026) |
| 📅 **Last Quarter** | Q1 FY2026 (April – June 2026) |
| 📅 **Last 6 Months** | March – August 2026 |
| 📅 **Full Financial Year** | FY2026 (April 2025 – March 2026) |
| 📅 **All-Time** | Entire dataset — all records |

Or type a custom range such as *"since April"* or *"Q1 FY2026"*.`;
}

/**
 * Extracts a structured date range from the conversation history.
 * Only activates when the CURRENT user message itself references time.
 * This prevents date context bleeding into unrelated follow-up questions.
 * Returns null (all-time) when no time filter should apply.
 */
function extractDateRange(history: ChatMessage[]): DateRange | null {
  // Current message must reference time — otherwise always return null (all-time)
  const currentMessage = history.at(-1)?.content.toLowerCase() ?? "";
  const TIME_WORDS = [
    "quarter", "month", "q1", "q2", "q3", "q4", "fy", "year",
    "recent", "6 months", "six months", "3 months", "all-time", "all time",
    "april", "may", "june", "july", "august", "september", "october",
    "november", "december", "january", "february", "march",
  ];
  const currentHasTimeRef = TIME_WORDS.some((w) => currentMessage.includes(w));
  if (!currentHasTimeRef) return null; // No time word in current query → all-time

  // Now scan recent history for the resolved time period answer
  const recentText = history
    .slice(-6)
    .map((m) => m.content.toLowerCase())
    .join(" ");

  const now = new Date();

  // Current quarter: Q2 FY2026 (Jul–Sep 2026)
  if (
    recentText.includes("current quarter") ||
    recentText.includes("q2 fy2026") ||
    recentText.includes("q2") ||
    recentText.includes("july") ||
    recentText.includes("jul")
  ) {
    return {
      start: new Date(2026, 6, 1),
      end: new Date(2026, 8, 30, 23, 59, 59),
      label: "Q2 FY2026 (Jul–Sep 2026)",
    };
  }

  // Last quarter: Q1 FY2026 (Apr–Jun 2026)
  if (
    recentText.includes("last quarter") ||
    recentText.includes("q1 fy2026") ||
    recentText.includes("q1") ||
    recentText.includes("april") || recentText.includes("june")
  ) {
    return {
      start: new Date(2026, 3, 1),
      end: new Date(2026, 5, 30, 23, 59, 59),
      label: "Q1 FY2026 (Apr–Jun 2026)",
    };
  }

  // Last 6 months
  if (recentText.includes("6 months") || recentText.includes("six months")) {
    const start = new Date(now);
    start.setMonth(start.getMonth() - 6);
    return { start, end: now, label: "Last 6 months" };
  }

  // Last 3 months
  if (recentText.includes("3 months") || recentText.includes("three months")) {
    const start = new Date(now);
    start.setMonth(start.getMonth() - 3);
    return { start, end: now, label: "Last 3 months" };
  }

  // Full FY2026
  if (
    recentText.includes("fy2026") ||
    recentText.includes("fy 2026") ||
    recentText.includes("full financial year") ||
    recentText.includes("full year")
  ) {
    return {
      start: new Date(2025, 3, 1),
      end: new Date(2026, 2, 31, 23, 59, 59),
      label: "FY2026 (Apr 2025–Mar 2026)",
    };
  }

  // All-time explicitly requested
  if (
    recentText.includes("all-time") ||
    recentText.includes("all time") ||
    recentText.includes("entire") ||
    recentText.includes("everything")
  ) {
    return null;
  }

  return null; // Default: no filter (all-time)
}

/**
 * Filter records by a date field falling within the DateRange.
 * Records with no date are excluded when a range is active (conservative).
 */
function applyDateFilter(
  records: Record<string, unknown>[],
  dateField: string,
  range: DateRange | null
): Record<string, unknown>[] {
  if (!range) return records;
  return records.filter((r) => {
    const d = r[dateField];
    if (!(d instanceof Date)) return false;
    return d >= range.start && d <= range.end;
  });
}

// ─── Query Router ─────────────────────────────────────────────────────────

type DataSource = "work_orders" | "deals" | "both";

function classifyQuery(query: string): DataSource {
  const q = query.toLowerCase();

  const isExplicitWO =
    q.includes("work order") || q.includes("work_order") ||
    q.includes("completed work") || q.includes("billed") ||
    q.includes("invoiced") || q.includes("executed project");

  const isExplicitDeal =
    q.includes("deal") || q.includes("pipeline") || q.includes("stage") ||
    q.includes("funnel") || q.includes("prospect") || q.includes("lead") ||
    q.includes("win rate") || q.includes("conversion") || q.includes("close");

  if (isExplicitWO && !isExplicitDeal) return "work_orders";
  if (isExplicitDeal && !isExplicitWO) return "deals";

  const workOrderKeywords = [
    "execution", "operational", "deployed", "flight", "pilot", "team",
    "task", "deliverable", "milestone", "timeline", "deadline", "assignment",
  ];
  const dealKeywords = [
    "sales", "revenue", "opportunity", "crm", "forecast", "target",
    "won", "lost", "probability",
  ];

  const hasWO = workOrderKeywords.some((k) => q.includes(k));
  const hasDeal = dealKeywords.some((k) => q.includes(k));

  if (hasWO && !hasDeal) return "work_orders";
  if (hasDeal && !hasWO) return "deals";
  return "both";
}

// ─── Data Fetcher ─────────────────────────────────────────────────────────

interface FetchedData {
  workOrders?: Record<string, unknown>[];
  deals?: Record<string, unknown>[];
  qualityWarnings: string[];
  errors: string[];
}

async function fetchRelevantData(source: DataSource): Promise<FetchedData> {
  const result: FetchedData = { qualityWarnings: [], errors: [] };

  const fetchBoard = async (
    fetcher: () => Promise<RawBoardData>,
    cleaner: (r: Record<string, string>) => Record<string, unknown>,
    importantFields: string[],
    key: "workOrders" | "deals"
  ) => {
    try {
      const raw = await fetcher();
      const objects = raw.items.map(itemToObject);
      const cleaned = objects.map(cleaner);
      const quality = analyzeQuality(objects, importantFields);
      result[key] = cleaned;
      result.qualityWarnings.push(...quality.warnings);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push(`Failed to fetch ${key}: ${msg}`);
    }
  };

  const tasks: Promise<void>[] = [];

  if (source === "work_orders" || source === "both") {
    tasks.push(
      fetchBoard(
        getWorkOrders,
        cleanWorkOrder,
        ["WO Status (billed)", "Sector", "Amount in Rupees (Excl of GST) (Masked)"],
        "workOrders"
      )
    );
  }

  if (source === "deals" || source === "both") {
    tasks.push(
      fetchBoard(
        getDeals,
        cleanDeal,
        ["Deal Stage", "Sector/service", "Masked Deal value"],
        "deals"
      )
    );
  }

  await Promise.all(tasks);
  return result;
}

// ─── System Prompt Builder ────────────────────────────────────────────────

function buildSystemPrompt(
  data: FetchedData,
  userQuery: string,
  dateRange: DateRange | null
): string {
  const q = userQuery.toLowerCase();

  // Sector filter from query text
  const SECTORS = [
    "energy", "mining", "railways", "powerline", "renewables", "dsp",
    "oil", "agriculture", "defence", "telecom", "smart city", "infrastructure",
    "aviation", "construction", "manufacturing",
  ];
  const mentionedSector = SECTORS.find((s) => q.includes(s));

  const dateLabel = dateRange ? `**Filtered to: ${dateRange.label}**` : "**All-time data**";

  const parts: string[] = [
    `You are Skylark Intelligence, an expert BI analyst for Skylark Drones (Indian drone services company).
Answer the user's business question using ONLY the structured data below. Be precise, complete, and executive-ready.
${dateLabel}

RESPONSE RULES (follow strictly):
1. Use markdown headers, bullet points, and tables for structure.
2. Format all values as ₹ (e.g. ₹68.16 Cr, ₹12.5 L). Never print raw numbers like 2348928.
3. NEVER print database IDs or raw JSON field names.
4. When listing deals/orders, use a markdown table: | Name | Stage | Sector | Client | Value |
5. Always end with 2–3 "**Key Actions**" bullet points.
6. If data is missing or zero, say so clearly and explain why.
7. If the question cannot be answered from the data provided, say so explicitly — do not invent numbers.
${dateRange ? `8. All figures below are filtered to: ${dateRange.label}` : "8. All figures are all-time (no date filter applied)."}

Data Quality: ${data.qualityWarnings.length > 0 ? data.qualityWarnings.map((w) => `⚠️ ${w}`).join("; ") : "✅ Good"}
${data.errors.length > 0 ? `\n⚠️ Data Errors: ${data.errors.join("; ")}` : ""}`,
  ];

  // ── Deals ──
  if (data.deals) {
    // Apply date-range filter on closeDateRaw
    const filteredDeals = dateRange
      ? applyDateFilter(data.deals, "closeDateRaw", dateRange)
      : data.deals;

    const summary = summarizeDeals(filteredDeals);
    const rangeNote = dateRange
      ? ` (${filteredDeals.length} of ${data.deals.length} deals fall within ${dateRange.label})`
      : "";

    parts.push(`
## DEALS DATA${rangeNote}
- Total Records in Range: ${summary.totalCount} | With value: ${summary.dealsWithValue} | Missing value: ${summary.dealsWithoutValue}
- Total Pipeline Value: ${summary.totalValueFormatted}
- Open Active Pipeline (A–F stages): ${summary.openValueFormatted} across ${summary.openCount} deals
- Weighted Pipeline (probability-adjusted): ${summary.weightedPipelineFormatted}
- Won: ${summary.wonCount} | Lost: ${summary.lostCount} | Win Rate: ${summary.winRate}
- Avg Deal Size (valued deals): ${summary.avgDealSizeFormatted}
- ⚠️ Note: ${summary.dealsWithoutValue} deals (${Math.round((summary.dealsWithoutValue / Math.max(summary.totalCount, 1)) * 100)}%) have no deal value in Monday.com

### Stage Breakdown:
${Object.entries(summary.stageBreakdown)
  .sort((a, b) => b[1].value - a[1].value)
  .map(([stage, d]) => `- ${stage}: ${d.count} deals | ${d.formatted}`)
  .join("\n")}

### Sector Breakdown:
${Object.entries(summary.sectorBreakdown)
  .sort((a, b) => b[1].value - a[1].value)
  .map(([sector, d]) => `- ${sector}: ${d.count} deals | ${d.formatted}`)
  .join("\n")}`);

    // Individual deal rows for sector/detail queries
    const needsDetail =
      mentionedSector ||
      q.includes("which") || q.includes("list") || q.includes("show") ||
      q.includes("at risk") || q.includes("lost") || q.includes("top") ||
      q.includes("focus") || q.includes("leadership");

    if (needsDetail) {
      const detailDeals = filteredDeals
        .filter((d) => {
          if ((d.dealValue as number) <= 0) return false;
          if (mentionedSector) return String(d.sector).toLowerCase().includes(mentionedSector);
          return true;
        })
        .sort((a, b) => (b.dealValue as number) - (a.dealValue as number))
        .slice(0, 20)
        .map(({ _raw, id, closeDateRaw, startDateRaw, endDateRaw, ...rest }) => rest); // eslint-disable-line @typescript-eslint/no-unused-vars

      if (detailDeals.length > 0) {
        const label = mentionedSector
          ? `${mentionedSector.toUpperCase()} SECTOR DEALS`
          : "TOP VALUED DEALS";
        parts.push(`\n### ${label} (top ${detailDeals.length}, sorted by value):\n\`\`\`json\n${JSON.stringify(detailDeals, null, 0)}\n\`\`\``);
      }
    }
  }

  // ── Work Orders ──
  if (data.workOrders) {
    // For WO date filtering, a record is "in range" if its end date (completion)
    // OR start date falls within the window. End date is prioritised for revenue
    // queries since completion time determines when revenue is recognised.
    const filteredWO = dateRange
      ? data.workOrders.filter((w) => {
          const end = w["endDateRaw"];
          const start = w["startDateRaw"];
          const inRange = (d: unknown) =>
            d instanceof Date && d >= dateRange.start && d <= dateRange.end;
          return inRange(end) || inRange(start);
        })
      : data.workOrders;

    const summary = summarizeWorkOrders(filteredWO);
    const rangeNote = dateRange
      ? ` (${filteredWO.length} of ${data.workOrders.length} work orders active in ${dateRange.label})`
      : "";

    parts.push(`
## WORK ORDERS DATA${rangeNote}
- Total Records in Range: ${summary.totalCount}
- Completed: ${summary.completedCount} | Contract Value: ${summary.completedContractValueFormatted}
- Active / Ongoing: ${summary.activeCount}
- On Hold: ${summary.onHoldCount} | Not Started: ${summary.notStartedCount}
- Overdue (past end date, not completed): ${summary.overdueCount}
- Total Contract Value: ${summary.totalContractValueFormatted}
- Total Billed Value: ${summary.totalBilledValueFormatted}
- Collection Rate: ${summary.collectionRate}
- ⚠️ Note: Status derived from Execution Status for records with empty billing status

### Status Breakdown:
${Object.entries(summary.statusBreakdown)
  .sort((a, b) => b[1].value - a[1].value)
  .map(([status, d]) => `- ${status}: ${d.count} orders | ${d.formatted}`)
  .join("\n")}

### Sector Breakdown:
${Object.entries(summary.sectorBreakdown)
  .sort((a, b) => b[1].value - a[1].value)
  .map(([sector, d]) => `- ${sector}: ${d.count} orders | ${d.formatted}`)
  .join("\n")}`);

    const needsWODetail =
      mentionedSector ||
      q.includes("which") || q.includes("list") || q.includes("show") ||
      q.includes("delayed") || q.includes("overdue") || q.includes("top") ||
      q.includes("bottleneck") || q.includes("risk") || q.includes("focus");

    if (needsWODetail) {
      const detailWO = filteredWO
        .filter((w) => {
          if (mentionedSector) return String(w.sector).toLowerCase().includes(mentionedSector);
          return (w.contractValue as number) > 0;
        })
        .sort((a, b) => (b.contractValue as number) - (a.contractValue as number))
        .slice(0, 20)
        .map(({ _raw, id, startDateRaw, endDateRaw, ...rest }) => rest); // eslint-disable-line @typescript-eslint/no-unused-vars

      if (detailWO.length > 0) {
        const label = mentionedSector
          ? `${mentionedSector.toUpperCase()} SECTOR WORK ORDERS`
          : "TOP VALUED WORK ORDERS";
        parts.push(`\n### ${label} (top ${detailWO.length}, sorted by value):\n\`\`\`json\n${JSON.stringify(detailWO, null, 0)}\n\`\`\``);
      }
    }
  }

  return parts.join("\n");
}

// ─── Main Agent Function ──────────────────────────────────────────────────

export async function runAgent(
  userMessage: string,
  history: ChatMessage[]
): Promise<ReadableStream<string>> {
  // ── Step 1: Ask a clarifying question if the query is time-ambiguous ──
  const clarification = needsClarification(userMessage, history);
  if (clarification) {
    return new ReadableStream<string>({
      start(controller) {
        controller.enqueue(clarification);
        controller.close();
      },
    });
  }

  // ── Step 2: Extract date range from conversation (after clarification) ──
  const fullHistory = [...history, { role: "user" as const, content: userMessage }];
  const dateRange = extractDateRange(fullHistory);

  // ── Step 3: Classify query and fetch data from Monday.com ──
  const source = classifyQuery(userMessage);
  const data = await fetchRelevantData(source);

  // ── Step 4: Build structured system prompt with date-filtered data ──
  const systemPrompt = buildSystemPrompt(data, userMessage, dateRange);

  // ── Step 5: Build Gemini conversation history (last 4 messages) ──
  const rawHistory: Content[] = history.slice(-4).map((msg) => ({
    role: msg.role,
    parts: [{ text: msg.content }],
  }));
  const firstUserIdx = rawHistory.findIndex((m) => m.role === "user");
  const geminiHistory: Content[] = firstUserIdx >= 0 ? rawHistory.slice(firstUserIdx) : [];

  // ── Step 6: Try Gemini models in fallback order ──
  const candidateModels = [
    "gemini-3.5-flash",      // latest recommended
    "gemini-3.5-flash-lite", // lite fallback
    "gemini-2.0-flash",      // stable fallback
    "gemini-1.5-flash",      // last resort
  ];

  let streamResult: AsyncIterable<{ text: () => string }> | null = null;
  let lastError: Error | null = null;

  for (const modelName of candidateModels) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: systemPrompt,
        generationConfig: {
          maxOutputTokens: 2048,
          temperature: 0.2,
        },
      });

      const chat = model.startChat({ history: geminiHistory });

      // 8-second hard timeout per model attempt
      const streamPromise = chat.sendMessageStream(userMessage);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Gemini API timeout after 8s")), 8000)
      );

      streamResult = (await Promise.race([streamPromise, timeoutPromise])).stream;
      if (streamResult) break;
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`Model ${modelName} failed:`, lastError.message);
      if (lastError.message.includes("API key") || lastError.message.includes("403")) break;
    }
  }

  if (!streamResult) {
    throw lastError || new Error("All Gemini model fallbacks exhausted.");
  }

  // ── Step 7: Stream response back to client ──
  return new ReadableStream<string>({
    async start(controller) {
      try {
        for await (const chunk of streamResult!) {
          const text = chunk.text();
          if (text) controller.enqueue(text);
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Unknown error";
        controller.enqueue(`\n\n⚠️ Error generating response: ${msg}`);
      } finally {
        controller.close();
      }
    },
  });
}
