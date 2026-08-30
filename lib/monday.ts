/**
 * Monday.com API Client
 * Fetches data from Work Orders and Deals boards via GraphQL
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
}

async function mondayGraphQL(query: string, variables?: Record<string, unknown>): Promise<unknown> {
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

const cache = new Map<string, { timestamp: number; data: MondayItem[] }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch all items from a board (handles pagination up to 500 items, cached for 5 min)
 */
async function fetchBoardItems(boardId: string): Promise<MondayItem[]> {
  const cached = cache.get(boardId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const query = `
    query GetBoardItems($boardId: ID!, $cursor: String) {
      boards(ids: [$boardId]) {
        id
        name
        items_page(limit: 500, cursor: $cursor) {
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

  const allItems: MondayItem[] = [];
  let cursor: string | null = null;
  let boardName = "";
  let firstPage = true;

  do {
    const data = (await mondayGraphQL(query, { boardId, cursor: cursor ?? undefined })) as {
      boards: MondayBoard[];
    };

    const board = data.boards[0];
    if (!board) throw new Error(`Board ${boardId} not found.`);

    if (firstPage) {
      boardName = board.name;
      firstPage = false;
    }

    allItems.push(...board.items_page.items);
    cursor = board.items_page.cursor;
  } while (cursor);

  cache.set(boardId, { timestamp: Date.now(), data: allItems });
  return allItems;
}

/**
 * Fetch Work Orders board data
 */
export async function getWorkOrders(): Promise<RawBoardData> {
  const boardId = process.env.WORK_ORDERS_BOARD_ID;
  if (!boardId) throw new Error("WORK_ORDERS_BOARD_ID environment variable is not set.");

  const items = await fetchBoardItems(boardId);
  return { boardName: "Work Orders", boardId, items };
}

/**
 * Fetch Deals board data
 */
export async function getDeals(): Promise<RawBoardData> {
  const boardId = process.env.DEALS_BOARD_ID;
  if (!boardId) throw new Error("DEALS_BOARD_ID environment variable is not set.");

  const items = await fetchBoardItems(boardId);
  return { boardName: "Deals", boardId, items };
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
