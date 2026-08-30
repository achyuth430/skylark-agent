/**
 * Data Cleaning & Normalization Layer
 * Handles real-world messy data from Monday.com boards
 */

// ─── Date Normalization ────────────────────────────────────────────────────

const DATE_PATTERNS: Array<{ regex: RegExp; parse: (m: RegExpMatchArray) => Date | null }> = [
  // ISO: 2024-01-15
  {
    regex: /^(\d{4})-(\d{2})-(\d{2})$/,
    parse: (m) => new Date(+m[1], +m[2] - 1, +m[3]),
  },
  // DD/MM/YYYY or DD-MM-YYYY
  {
    regex: /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/,
    parse: (m) => new Date(+m[3], +m[2] - 1, +m[1]),
  },
  // MM/DD/YYYY
  {
    regex: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
    parse: (m) => {
      const d1 = +m[1], d2 = +m[2];
      // Heuristic: if first number > 12 it must be a day
      if (d1 > 12) return new Date(+m[3], d2 - 1, d1);
      return new Date(+m[3], d1 - 1, d2); // assume MM/DD
    },
  },
  // Month name: "15 Jan 2024", "Jan 15, 2024"
  {
    regex: /(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/,
    parse: (m) => new Date(`${m[2]} ${m[1]}, ${m[3]}`),
  },
  {
    regex: /([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/,
    parse: (m) => new Date(`${m[1]} ${m[2]}, ${m[3]}`),
  },
];

export function parseDate(raw: string | null | undefined): Date | null {
  if (!raw || raw.trim() === "" || raw === "-" || raw === "N/A") return null;
  const s = raw.trim();

  // Try JS native first
  const native = new Date(s);
  if (!isNaN(native.getTime()) && native.getFullYear() > 2000) return native;

  for (const { regex, parse } of DATE_PATTERNS) {
    const m = s.match(regex);
    if (m) {
      const d = parse(m);
      if (d && !isNaN(d.getTime())) return d;
    }
  }
  return null;
}

export function formatDate(d: Date | null): string {
  if (!d) return "Unknown";
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

// ─── Currency / Number Normalization ─────────────────────────────────────

export function parseCurrency(raw: string | null | undefined): number | null {
  if (!raw || raw.trim() === "" || raw === "-" || raw === "N/A") return null;
  const cleaned = raw.replace(/[₹$€£,\s]/g, "").replace(/[Kk]$/, "000").replace(/[Mm]$/, "000000");
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

export function formatCurrency(n: number | null): string {
  if (n === null) return "Unknown";
  if (n >= 10_000_000) return `₹${(n / 10_000_000).toFixed(2)} Cr`;
  if (n >= 100_000) return `₹${(n / 100_000).toFixed(2)} L`;
  return `₹${n.toLocaleString("en-IN")}`;
}

// ─── Text / Enum Normalization ────────────────────────────────────────────

const SECTOR_MAP: Record<string, string> = {
  energy: "Energy", "oil & gas": "Oil & Gas", "oil and gas": "Oil & Gas",
  agriculture: "Agriculture", agri: "Agriculture",
  defence: "Defence", defense: "Defence",
  mining: "Mining",
  infrastructure: "Infrastructure", infra: "Infrastructure",
  "smart city": "Smart Cities", "smart cities": "Smart Cities",
  telecom: "Telecom", telecommunications: "Telecom",
  logistics: "Logistics",
  construction: "Construction",
  survey: "Surveying", surveying: "Surveying",
};

export function normalizeSector(raw: string | null | undefined): string {
  if (!raw || raw.trim() === "") return "Unknown";
  const key = raw.trim().toLowerCase();
  return SECTOR_MAP[key] ?? raw.trim();
}

const STATUS_MAP: Record<string, string> = {
  "in progress": "In Progress", "inprogress": "In Progress", "wip": "In Progress",
  completed: "Completed", complete: "Completed", done: "Completed", finished: "Completed",
  pending: "Pending", "not started": "Pending", "new": "Pending",
  cancelled: "Cancelled", canceled: "Cancelled",
  "on hold": "On Hold", hold: "On Hold",
  won: "Won", "closed won": "Won",
  lost: "Lost", "closed lost": "Lost",
  "in discussion": "In Discussion", discussion: "In Discussion",
  proposal: "Proposal Sent", "proposal sent": "Proposal Sent",
  qualified: "Qualified",
  "demo scheduled": "Demo Scheduled",
};

export function normalizeStatus(raw: string | null | undefined): string {
  if (!raw || raw.trim() === "") return "Unknown";
  const key = raw.trim().toLowerCase();
  return STATUS_MAP[key] ?? raw.trim();
}

// ─── Data Quality Reporting ───────────────────────────────────────────────

export interface DataQualityReport {
  totalRecords: number;
  missingFields: Record<string, number>;
  warnings: string[];
}

export function analyzeQuality(
  records: Record<string, string>[],
  importantFields: string[]
): DataQualityReport {
  const missingFields: Record<string, number> = {};
  const warnings: string[] = [];

  for (const field of importantFields) {
    const missing = records.filter((r) => !r[field] || r[field].trim() === "").length;
    if (missing > 0) missingFields[field] = missing;
  }

  const missingPct = Object.entries(missingFields)
    .filter(([, v]) => v / records.length > 0.2)
    .map(([k, v]) => `"${k}" is missing in ${Math.round((v / records.length) * 100)}% of records`);

  if (missingPct.length > 0) {
    warnings.push(`Data quality note: ${missingPct.join("; ")}.`);
  }

  return { totalRecords: records.length, missingFields, warnings };
}

// ─── Full Record Cleaner ──────────────────────────────────────────────────

export function cleanWorkOrder(raw: Record<string, string>): Record<string, unknown> {
  const amount = parseCurrency(
    raw["Amount in Rupees (Excl of GST) (Masked)"] ??
    raw["Amount in Rupees (Incl of GST) (Masked)"] ??
    raw["Contract Value"] ?? raw["Amount"] ?? raw["Value"] ?? raw["Budget"]
  );
  const billedAmount = parseCurrency(
    raw["Billed Value in Rupees (Excl of GST.) (Masked)"] ??
    raw["Billed Value in Rupees (Incl of GST.) (Masked)"]
  );
  const startDate = parseDate(raw["Probable Start Date"] ?? raw["Start Date"] ?? raw["start_date"]);
  const endDate = parseDate(raw["Probable End Date"] ?? raw["End Date"] ?? raw["end_date"] ?? raw["Deadline"]);

  return {
    id: raw.id,
    name: raw.name || "Unnamed Work Order",
    status: normalizeStatus(raw["WO Status (billed)"] ?? raw["Billing Status"] ?? raw["Invoice Status"] ?? raw["Status"] ?? raw["status"]),
    sector: normalizeSector(raw["Sector"] ?? raw["Industry"] ?? raw["Category"]),
    client: raw["Client Code"] ?? raw["Client"] ?? raw["Customer"] ?? raw["Account"] ?? "Unknown",
    contractValue: amount,
    contractValueFormatted: formatCurrency(amount),
    billedValue: billedAmount,
    billedValueFormatted: formatCurrency(billedAmount),
    startDate: formatDate(startDate),
    endDate: formatDate(endDate),
    assignee: raw["BD/KAM Personnel code"] ?? raw["Assignee"] ?? raw["Owner"] ?? raw["Person"] ?? "Unassigned",
    workType: raw["Type of Work"] ?? raw["Work Type"] ?? "",
    notes: raw["Notes"] ?? raw["Description"] ?? "",
  };
}

export function cleanDeal(raw: Record<string, string>): Record<string, unknown> {
  const value = parseCurrency(
    raw["Masked Deal value"] ?? raw["Deal Value"] ?? raw["Value"] ?? raw["Amount"] ?? raw["Revenue"]
  );
  const closeDate = parseDate(
    raw["Tentative Close Date"] ?? raw["Close Date (A)"] ?? raw["Close Date"] ?? raw["Expected Close"]
  );
  const probStr = raw["Closure Probability"] ?? raw["Probability"] ?? raw["Win Probability"] ?? "";
  const prob = probStr ? parseFloat(probStr.replace("%", "")) : null;

  return {
    id: raw.id,
    name: raw.name || "Unnamed Deal",
    stage: raw["Deal Stage"] ?? raw["Stage"] ?? "Unknown",
    status: normalizeStatus(raw["Deal Status"] ?? raw["Status"] ?? raw["status"]),
    sector: normalizeSector(raw["Sector/service"] ?? raw["Sector"] ?? raw["Industry"] ?? raw["Vertical"]),
    client: raw["Client Code"] ?? raw["Client"] ?? raw["Account"] ?? raw["Company"] ?? "Unknown",
    dealValue: value,
    dealValueFormatted: formatCurrency(value),
    probability: probStr || (prob !== null && !isNaN(prob) ? `${prob}%` : "Unknown"),
    closeDate: formatDate(closeDate),
    owner: raw["Owner code"] ?? raw["Owner"] ?? raw["Sales Rep"] ?? raw["Assignee"] ?? "Unassigned",
    product: raw["Product deal"] ?? "",
  };
}
