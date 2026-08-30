/**
 * BI Agent Core Logic
 * Orchestrates query understanding, Monday.com data fetching, and Gemini response generation
 */

import { getWorkOrders, getDeals, itemToObject, RawBoardData } from "./monday";
import { cleanWorkOrder, cleanDeal, analyzeQuality, summarizeDeals, summarizeWorkOrders } from "./dataClean";
import { GoogleGenerativeAI, Content } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

// ─── Query Router ─────────────────────────────────────────────────────────

type DataSource = "work_orders" | "deals" | "both";

function classifyQuery(query: string): DataSource {
  const q = query.toLowerCase();

  const isExplicitWO = q.includes("work order") || q.includes("work_order") || q.includes("completed work");
  const isExplicitDeal = q.includes("deal") || q.includes("pipeline") || q.includes("stage");

  if (isExplicitWO && !isExplicitDeal) return "work_orders";
  if (isExplicitDeal && !isExplicitWO) return "deals";

  const workOrderKeywords = [
    "project", "execution", "operational", "deployed",
    "flight", "pilot", "team", "task", "deliverable", "milestone",
    "timeline", "deadline", "contract", "assignment", "billed",
  ];

  const dealKeywords = [
    "sales", "prospect", "lead",
    "win", "lost", "close", "probability", "conversion", "funnel",
    "opportunity", "crm", "forecast", "target",
  ];

  const hasWO = workOrderKeywords.some((k) => q.includes(k));
  const hasDeal = dealKeywords.some((k) => q.includes(k));

  if (hasWO && !hasDeal) return "work_orders";
  if (hasDeal && !hasWO) return "deals";
  return "both"; // default: check both boards for cross-board analysis
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

function buildSystemPrompt(data: FetchedData): string {
  const parts: string[] = [
    `You are Skylark Intelligence, a Business Intelligence agent for Skylark Drones — a drone services company operating in India.
You have access to real-time data from their Monday.com boards.
Your job is to answer founder-level business questions with clarity, precision, and actionable insights.

Guidelines:
- Use the PRE-COMPUTED AGGREGATES provided below for exact 100% dataset metrics (totals, sector splits, stage funnels, win rates).
- ALWAYS synthesize data into executive summaries, KPI metrics, tables, and sector-level aggregations.
- NEVER list out raw individual records or print internal database IDs (e.g. "ID: 2848226101").
- Format deal & order details in markdown tables with columns: Name, Stage/Status, Sector, Client, Value.
- Keep your response structured, direct, and thorough (use headers, bullet points, and tables).
- If data is missing or incomplete, acknowledge it transparently and work with what's available.
- Think like a CFO/COO when interpreting the data.
- For "leadership updates", produce a board-ready executive summary with key metrics, trends, and action items.

Data Quality Notes:
${data.qualityWarnings.length > 0 ? data.qualityWarnings.map((w) => `⚠️ ${w}`).join("\n") : "✅ Data quality looks acceptable."}
`,
  ];

  if (data.errors.length > 0) {
    parts.push(`\nDATA FETCH ERRORS (answer as best you can):\n${data.errors.join("\n")}`);
  }

  if (data.deals) {
    const summary = summarizeDeals(data.deals);
    parts.push(`\n## DEALS BOARD PRE-COMPUTED AGGREGATES (100% of ${summary.totalCount} records)\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\``);
    
    // Also include active deals with value > 0 (without raw database IDs)
    const valuedDeals = data.deals.filter(d => (d.dealValue as number) > 0).map(({ _raw, id, ...rest }) => rest);
    parts.push(`\n## ACTIVE VALUED DEALS LIST (${valuedDeals.length} deals)\n\`\`\`json\n${JSON.stringify(valuedDeals)}\n\`\`\``);
  }

  if (data.workOrders) {
    const summary = summarizeWorkOrders(data.workOrders);
    parts.push(`\n## WORK ORDERS BOARD PRE-COMPUTED AGGREGATES (100% of ${summary.totalCount} records)\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\``);
    
    const valuedWO = data.workOrders.filter(w => (w.contractValue as number) > 0).map(({ _raw, id, ...rest }) => rest);
    parts.push(`\n## ACTIVE VALUED WORK ORDERS LIST (${valuedWO.length} orders)\n\`\`\`json\n${JSON.stringify(valuedWO)}\n\`\`\``);
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
  // 1. Classify the query
  const source = classifyQuery(userMessage);

  // 2. Fetch relevant data from Monday.com
  const data = await fetchRelevantData(source);

  // 3. Build system prompt with live data injected
  const systemPrompt = buildSystemPrompt(data);

  // 4. Build conversation history for Gemini
  // Keep only the last 4 messages to avoid token blowup and timeouts on follow-up questions
  const rawHistory: Content[] = history.slice(-4).map((msg) => ({
    role: msg.role,
    parts: [{ text: msg.content }],
  }));
  const firstUserIdx = rawHistory.findIndex((m) => m.role === "user");
  const geminiHistory: Content[] = firstUserIdx >= 0 ? rawHistory.slice(firstUserIdx) : [];

  // 5. Create Gemini chat with streaming (with automatic model fallback on 429 rate limit)
  const candidateModels = [
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3.6-flash",
  ];

  let streamResult: any = null;
  let lastError: Error | null = null;

  for (const modelName of candidateModels) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: systemPrompt,
        generationConfig: {
          maxOutputTokens: 1500,
        },
      });

      const chat = model.startChat({ history: geminiHistory });
      streamResult = await chat.sendMessageStream(userMessage);
      if (streamResult) break;
    } catch (err: unknown) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`Model ${modelName} failed, trying next fallback:`, lastError.message);
    }
  }

  if (!streamResult) {
    throw lastError || new Error("All Gemini model fallbacks failed.");
  }

  // 6. Return a ReadableStream that emits text chunks
  return new ReadableStream<string>({
    async start(controller) {
      try {
        for await (const chunk of streamResult.stream) {
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
