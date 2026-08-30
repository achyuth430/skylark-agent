/**
 * BI Agent Core Logic
 * Orchestrates query understanding, Monday.com data fetching, and Gemini response generation
 */

import { getWorkOrders, getDeals, itemToObject, RawBoardData } from "./monday";
import { cleanWorkOrder, cleanDeal, analyzeQuality, summarizeDeals, summarizeWorkOrders, formatCurrency } from "./dataClean";
import { GoogleGenerativeAI, Content } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

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

function buildSystemPrompt(data: FetchedData, userQuery: string): string {
  const q = userQuery.toLowerCase();

  // Detect sector filter from query
  const SECTORS = ["energy", "mining", "railways", "powerline", "renewables", "dsp", "oil", "agriculture", "defence", "telecom", "smart city", "infrastructure"];
  const mentionedSector = SECTORS.find((s) => q.includes(s));

  const parts: string[] = [
    `You are Skylark Intelligence, an expert BI analyst for Skylark Drones (drone services company in India).
Answer the user's business question using ONLY the structured data below. Be precise, complete, and executive-ready.

RESPONSE RULES (follow strictly):
1. Use markdown headers, bullet points, and tables for structure.
2. Use ₹ formatted values (e.g. ₹68.16 Cr, ₹12.5 L). Never print raw numbers like 2348928.
3. NEVER print database IDs (e.g. "ID: 28482...") or raw JSON fields.
4. When listing deals/orders, use a clean markdown table: | Deal/Order | Stage | Sector | Client | Value |
5. Always end with 2-3 bullet point "Key Actions" or "Recommendations".
6. If data is missing or zero, say so clearly and explain what data exists.

Data Quality: ${data.qualityWarnings.length > 0 ? data.qualityWarnings.map((w) => `⚠️ ${w}`).join("; ") : "✅ Good"}
${data.errors.length > 0 ? `\nData Errors: ${data.errors.join("; ")}` : ""}`,
  ];

  // ── Deals aggregates ──
  if (data.deals) {
    const summary = summarizeDeals(data.deals);
    parts.push(`
## DEALS DATA (${summary.totalCount} total records | ${summary.dealsWithValue} have values | ${summary.dealsWithoutValue} missing values)
- Total Pipeline Value (all deals): ${summary.totalValueFormatted}
- Open Active Pipeline (A–F stages): ${summary.openValueFormatted} across ${summary.openCount} deals
- Weighted Pipeline (probability-adjusted): ${summary.weightedPipelineFormatted}
- Won: ${summary.wonCount} deals | Lost: ${summary.lostCount} deals | Win Rate: ${summary.winRate}
- Avg Deal Size (valued deals): ${summary.avgDealSizeFormatted}
- NOTE: ${summary.dealsWithoutValue} deals (${Math.round((summary.dealsWithoutValue/summary.totalCount)*100)}%) have no deal value recorded in Monday.com

### Stage Breakdown (by value):
${Object.entries(summary.stageBreakdown)
  .sort((a, b) => b[1].value - a[1].value)
  .map(([stage, d]) => `- ${stage}: ${d.count} deals | ${d.formatted}`)
  .join("\n")}

### Sector Breakdown (by value):
${Object.entries(summary.sectorBreakdown)
  .sort((a, b) => b[1].value - a[1].value)
  .map(([sector, d]) => `- ${sector}: ${d.count} deals | ${d.formatted}`)
  .join("\n")}`);

    // Only include individual deal details when sector or specific breakdown is asked
    const needsDetail =
      mentionedSector ||
      q.includes("which") || q.includes("list") || q.includes("show") ||
      q.includes("at risk") || q.includes("lost") || q.includes("top");

    if (needsDetail) {
      const filteredDeals = data.deals
        .filter((d) => {
          if ((d.dealValue as number) <= 0) return false;
          if (mentionedSector) return String(d.sector).toLowerCase().includes(mentionedSector);
          return true;
        })
        .slice(0, 20) // cap at 20 to avoid token bloat
        .map(({ _raw, id, ...rest }) => rest);

      if (filteredDeals.length > 0) {
        const label = mentionedSector ? `${mentionedSector.toUpperCase()} SECTOR DEALS` : "TOP VALUED DEALS";
        parts.push(`\n### ${label} (${filteredDeals.length} records):\n\`\`\`json\n${JSON.stringify(filteredDeals)}\n\`\`\``);
      }
    }
  }

  // ── Work Orders aggregates ──
  if (data.workOrders) {
    const summary = summarizeWorkOrders(data.workOrders);
    parts.push(`
## WORK ORDERS DATA (${summary.totalCount} total records)
- Total Contract Value: ${summary.totalContractValueFormatted}
- Completed Orders: ${summary.completedCount} | Contract Value: ${summary.completedContractValueFormatted}
- Active/Ongoing Orders: ${summary.activeCount}
- On Hold: ${summary.onHoldCount} | Not Started: ${summary.notStartedCount}
- Overdue (past end date, not completed): ${summary.overdueCount}
- Total Billed Value: ${summary.totalBilledValueFormatted}
- Collection Rate: ${summary.collectionRate}
- NOTE: Status derived from Execution Status for records with missing billing status

### Status Breakdown (by contract value):
${Object.entries(summary.statusBreakdown)
  .sort((a, b) => b[1].value - a[1].value)
  .map(([status, d]) => `- ${status}: ${d.count} orders | ${d.formatted}`)
  .join("\n")}

### Sector Breakdown (by contract value):
${Object.entries(summary.sectorBreakdown)
  .sort((a, b) => b[1].value - a[1].value)
  .map(([sector, d]) => `- ${sector}: ${d.count} orders | ${d.formatted}`)
  .join("\n")}`);

    const needsWODetail =
      mentionedSector ||
      q.includes("which") || q.includes("list") || q.includes("show") ||
      q.includes("completed") || q.includes("top");

    if (needsWODetail) {
      const filteredWO = data.workOrders
        .filter((w) => {
          if (mentionedSector) return String(w.sector).toLowerCase().includes(mentionedSector);
          return (w.contractValue as number) > 0;
        })
        .slice(0, 20)
        .map(({ _raw, id, ...rest }) => rest);

      if (filteredWO.length > 0) {
        const label = mentionedSector ? `${mentionedSector.toUpperCase()} SECTOR WORK ORDERS` : "TOP VALUED WORK ORDERS";
        parts.push(`\n### ${label} (${filteredWO.length} records):\n\`\`\`json\n${JSON.stringify(filteredWO)}\n\`\`\``);
      }
    }
  }

  return parts.join("\n");
}

// ─── Main Agent Function ──────────────────────────────────────────────────

export interface ChatMessage {
  role: "user" | "model";
  content: string;
}

export async function runAgent(
  userMessage: string,
  history: ChatMessage[]
): Promise<ReadableStream<string>> {
  // 1. Classify query
  const source = classifyQuery(userMessage);

  // 2. Fetch data (backed by local fallback — always fast)
  const data = await fetchRelevantData(source);

  // 3. Build lean, structured system prompt with relevant data only
  const systemPrompt = buildSystemPrompt(data, userMessage);

  // 4. Build history (last 4 msgs, must start with user)
  const rawHistory: Content[] = history.slice(-4).map((msg) => ({
    role: msg.role,
    parts: [{ text: msg.content }],
  }));
  const firstUserIdx = rawHistory.findIndex((m) => m.role === "user");
  const geminiHistory: Content[] = firstUserIdx >= 0 ? rawHistory.slice(firstUserIdx) : [];

  // 5. Correct Gemini model names with fallback chain
  const candidateModels = [
    "gemini-3.5-flash",        // latest recommended model
    "gemini-3.5-flash-lite",   // lite fallback (per API guidance)
    "gemini-2.0-flash",        // stable fallback
    "gemini-1.5-flash",        // last resort fallback
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
          temperature: 0.2, // low temp = consistent, factual output
        },
      });

      const chat = model.startChat({ history: geminiHistory });

      // Race Gemini API against 8s hard timeout (Vercel limit is 30s, data fetch takes ~2s)
      const streamPromise = chat.sendMessageStream(userMessage);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Gemini API timeout after 8s")), 8000)
      );

      streamResult = (await Promise.race([streamPromise, timeoutPromise])).stream;
      if (streamResult) break;
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`Model ${modelName} failed:`, lastError.message);
      // Only retry on rate limit or timeout, not auth errors
      if (lastError.message.includes("API key") || lastError.message.includes("403")) break;
    }
  }

  if (!streamResult) {
    throw lastError || new Error("All Gemini model fallbacks exhausted.");
  }

  // 6. Return a ReadableStream of text chunks
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
