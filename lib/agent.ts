/**
 * BI Agent Core Logic
 * Orchestrates query understanding, Monday.com data fetching, and Gemini response generation
 */

import { getWorkOrders, getDeals, itemToObject, RawBoardData } from "./monday";
import { cleanWorkOrder, cleanDeal, analyzeQuality } from "./dataClean";
import { GoogleGenerativeAI, Content } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

// ─── Query Router ─────────────────────────────────────────────────────────

type DataSource = "work_orders" | "deals" | "both";

function classifyQuery(query: string): DataSource {
  const q = query.toLowerCase();

  const workOrderKeywords = [
    "work order", "project", "execution", "operational", "deployed",
    "flight", "pilot", "team", "task", "deliverable", "milestone",
    "timeline", "deadline", "contract", "assignment",
  ];

  const dealKeywords = [
    "deal", "pipeline", "sales", "revenue", "prospect", "lead",
    "win", "lost", "close", "probability", "conversion", "funnel",
    "opportunity", "crm", "forecast", "quarter", "target",
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
        ["Status", "Client", "Contract Value", "Start Date", "End Date"],
        "workOrders"
      )
    );
  }

  if (source === "deals" || source === "both") {
    tasks.push(
      fetchBoard(
        getDeals,
        cleanDeal,
        ["Status", "Client", "Deal Value", "Close Date", "Probability"],
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
- Be concise but insightful. Don't just state numbers — explain what they mean.
- If data is missing or incomplete, acknowledge it transparently and work with what's available.
- Format responses with clear structure (use markdown headers, bullet points, and tables where helpful).
- Think like a CFO/COO when interpreting the data.
- If a question is ambiguous, state your interpretation before answering.
- For "leadership updates", produce a board-ready executive summary with key metrics, trends, and action items.

Data Quality Notes:
${data.qualityWarnings.length > 0 ? data.qualityWarnings.map((w) => `⚠️ ${w}`).join("\n") : "✅ Data quality looks acceptable."}
`,
  ];

  if (data.errors.length > 0) {
    parts.push(`\nDATA FETCH ERRORS (answer as best you can):\n${data.errors.join("\n")}`);
  }

  if (data.workOrders) {
    const compactWO = data.workOrders.map(({ _raw, ...rest }) => rest);
    parts.push(`\n## WORK ORDERS DATA (${compactWO.length} records)\n\`\`\`json\n${JSON.stringify(compactWO)}\n\`\`\``);
  }

  if (data.deals) {
    const compactDeals = data.deals.map(({ _raw, ...rest }) => rest);
    parts.push(`\n## DEALS / PIPELINE DATA (${compactDeals.length} records)\n\`\`\`json\n${JSON.stringify(compactDeals)}\n\`\`\``);
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

  // 5. Create Gemini chat with streaming
  const model = genAI.getGenerativeModel({
    model: "gemini-3.6-flash",
    systemInstruction: systemPrompt,
    generationConfig: {
      maxOutputTokens: 1200,
    },
  });

  const chat = model.startChat({ history: geminiHistory });
  const streamResult = await chat.sendMessageStream(userMessage);

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
