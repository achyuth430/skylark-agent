/**
 * Monday.com API Client
 * Fetches data live from Work Orders and Deals boards via GraphQL
 * No hardcoded/bundled data — all data comes from the Monday.com API.
 */

const MONDAY_API_URL = "https://api.monday.com/v2";

interface MondayColumn {
  id: string;
  column: { title: string };
  value: string | null;
  text: string | null;
  type: string;
}

interface MondayItem {
  id: string;
  name: string;
  column_values: MondayColumn[];
}

interface MondayBoard {
  id: string;
  name: string;
  items_page: {
    items: MondayItem[];
    cursor: string | null;
  };
}

export interface RawBoardData {
  boardName: string;
  boardId: string;
  items: MondayItem[];
  dataSource: "live" | "error";
}

async function mondayGraphQL(
  query: string,
  variables?: Record<string, unknown>
): Promise<unknown> {
  const token = process.env.MONDAY_API_KEY;
  if (!token) throw new Error("MONDAY_API_KEY environment variable is not set.");

  const res = await fetch(MONDAY_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token,
      "API-Version": "2024-01",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Monday.com API error ${res.status}: ${text}`);
  }

  const json = (await res.json()) as { data?: unknown; errors?: unknown[] };
  if (json.errors && json.errors.length > 0) {
    throw new Error(`Monday.com GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  return json.data;
}

// In-memory cache (5 minutes TTL) — reduces Monday.com API calls on repeated queries
const cache = new Map<string, { timestamp: number; data: MondayItem[] }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const GQL_QUERY = `
  query GetBoardItems($boardId: ID!) {
    boards(ids: [$boardId]) {
      id
      name
      items_page(limit: 500) {
        cursor
        items {
          id
          name
          column_values {
            id
            type
            text
            value
            column {
              title
            }
          }
        }
      }
    }
  }
`;

/**
 * Fetch all items from a board.
 * Cached for 5 minutes. Throws clearly on failure — no silent stale data.
 */
async function fetchBoardItems(boardId: string): Promise<MondayItem[]> {
  const cached = cache.get(boardId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const data = (await mondayGraphQL(GQL_QUERY, { boardId })) as {
    boards: MondayBoard[];
  };

  const board = data.boards[0];
  if (!board) throw new Error(`Board ${boardId} not found or not accessible.`);

  const items = board.items_page.items;
  cache.set(boardId, { timestamp: Date.now(), data: items });
  return items;
}

/**
 * Fetch Work Orders board data
 */
export async function getWorkOrders(): Promise<RawBoardData> {
  const boardId = process.env.WORK_ORDERS_BOARD_ID || "5030963276";
  const items = await fetchBoardItems(boardId);
  return { boardName: "Work Orders", boardId, items, dataSource: "live" };
}

/**
 * Fetch Deals board data
 */
export async function getDeals(): Promise<RawBoardData> {
  const boardId = process.env.DEALS_BOARD_ID || "5030963270";
  const items = await fetchBoardItems(boardId);
  return { boardName: "Deals", boardId, items, dataSource: "live" };
}

/**
 * Convert Monday.com item to a plain key-value object
 */
export function itemToObject(item: MondayItem): Record<string, string> {
  const obj: Record<string, string> = { id: item.id, name: item.name };
  for (const col of item.column_values) {
    const key = col.column?.title || col.id;
    obj[key] = col.text ?? col.value ?? "";
  }
  return obj;
}
