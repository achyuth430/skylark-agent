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
      if (d1 > 12) return new Date(+m[3], d2 - 1, d1);
      return new Date(+m[3], d1 - 1, d2);
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
  if (n === null || n === 0) return "₹0";
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
  powerline: "Powerline",
  renewables: "Renewables", renewable: "Renewables",
  railways: "Railways", railway: "Railways",
  dsp: "DSP",
  aviation: "Aviation",
  manufacturing: "Manufacturing",
  "security and surveillance": "Security & Surveillance",
  "security & surveillance": "Security & Surveillance",
  others: "Others", other: "Others",
  tender: "Tender",
};

export function normalizeSector(raw: string | null | undefined): string {
  if (!raw || raw.trim() === "" || raw.toLowerCase() === "sector/service") return "Unknown";
  const key = raw.trim().toLowerCase();
  return SECTOR_MAP[key] ?? raw.trim();
}

// STATUS_MAP covers all real statuses found in the Monday.com boards
const STATUS_MAP: Record<string, string> = {
  // Generic
  "in progress": "In Progress", inprogress: "In Progress", wip: "In Progress",
  completed: "Completed", complete: "Completed", done: "Completed", finished: "Completed",
  pending: "Pending", "not started": "Pending", new: "Pending",
  cancelled: "Cancelled", canceled: "Cancelled",
  "on hold": "On Hold", hold: "On Hold",
  won: "Won", "closed won": "Won",
  lost: "Lost", "closed lost": "Lost",
  "in discussion": "In Discussion", discussion: "In Discussion",
  proposal: "Proposal Sent", "proposal sent": "Proposal Sent",
  qualified: "Qualified",
  "demo scheduled": "Demo Scheduled",
  open: "Open",
  closed: "Closed",
  // Real WO billing statuses (including typos from the actual board)
  "billed": "Billed",
  "billed- visit 1": "Billed", "billed- visit 2": "Billed", "billed- visit 3": "Billed",
  "billed- visit 4": "Billed", "billed- visit 5": "Billed", "billed- visit 6": "Billed",
  "billed- visit 7": "Billed",
  "partially billed": "Partially Billed",
  "fully billed": "Billed",
  "not billed yet": "Not Billed",
  "not billable": "Not Billable",
  "update required": "Update Required",
  stuck: "Stuck",
  // Real WO execution statuses
  ongoing: "Active", "executed until current month": "Active",
  "partial completed": "In Progress",
  "pause / struck": "On Hold", "pause/struck": "On Hold",
  "details pending from client": "On Hold",
};

export function normalizeStatus(raw: string | null | undefined): string {
  if (!raw || raw.trim() === "") return "Unknown";
  const key = raw.trim().toLowerCase();
  return STATUS_MAP[key] ?? raw.trim();
}

/**
 * Derive a normalized execution status from Work Order fields.
 * Handles the 42% of WOs where "WO Status (billed)" is empty.
 */
export function deriveWOStatus(raw: Record<string, string>): string {
  // Primary: billing status
  const billingStatus = (raw["WO Status (billed)"] || "").trim();
  if (billingStatus) return normalizeStatus(billingStatus);

  // Fallback 1: Execution Status
  const execStatus = (raw["Execution Status"] || "").trim().toLowerCase();
  if (execStatus) {
    if (["completed", "done", "finished"].includes(execStatus)) return "Completed";
    if (["ongoing", "executed until current month", "partial completed", "in progress"].includes(execStatus)) return "Active";
    if (["not started", "new"].includes(execStatus)) return "Not Started";
    if (["pause / struck", "pause/struck", "details pending from client"].includes(execStatus)) return "On Hold";
    return normalizeStatus(execStatus);
  }

  // Fallback 2: Billing Status column
  const bStatus = (raw["Billing Status"] || "").trim();
  if (bStatus) return normalizeStatus(bStatus);

  return "Unknown";
}

// ─── Probability normalization ────────────────────────────────────────────
// Real board uses qualitative text: "High", "Medium", "Low"

const PROBABILITY_MAP: Record<string, number> = {
  high: 70,
  medium: 40,
  low: 15,
};

export function parseProbability(raw: string | null | undefined): number | null {
  if (!raw || raw.trim() === "") return null;
  const key = raw.trim().toLowerCase();
  // Direct numeric %
  if (key.endsWith("%")) {
    const n = parseFloat(key);
    return isNaN(n) ? null : n;
  }
  // Numeric without %
  const n = parseFloat(key);
  if (!isNaN(n)) return n;
  // Qualitative text
  return PROBABILITY_MAP[key] ?? null;
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
    .map(([k, v]) => `"${k}" missing in ${Math.round((v / records.length) * 100)}% of records`);

  if (missingPct.length > 0) {
    warnings.push(`Data quality: ${missingPct.join("; ")}.`);
  }

  return { totalRecords: records.length, missingFields, warnings };
}

// ─── Full Record Cleaners ─────────────────────────────────────────────────

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

  // Derive correct execution status — handles EMPTY billing status on 42% of records
  const derivedStatus = deriveWOStatus(raw);
  const isCompleted = derivedStatus === "Completed";
  const isActive = derivedStatus === "Active" || derivedStatus === "Open" || derivedStatus === "In Progress";

  // Overdue detection: endDate is in the past and not Completed
  const today = new Date();
  const isOverdue = endDate !== null && endDate < today && !isCompleted;

  return {
    id: raw.id,
    name: raw.name || "Unnamed Work Order",
    status: derivedStatus,
    executionStatus: raw["Execution Status"] ?? "",
    billingStatus: raw["WO Status (billed)"] ?? "",
    isCompleted,
    isActive,
    isOverdue,
    sector: normalizeSector(raw["Sector"] ?? raw["Industry"] ?? raw["Category"]),
    client: raw["Customer Name Code"] ?? raw["Client Code"] ?? raw["Client"] ?? raw["Customer"] ?? "Unknown",
    contractValue: amount ?? 0,
    contractValueFormatted: formatCurrency(amount),
    billedValue: billedAmount ?? 0,
    billedValueFormatted: formatCurrency(billedAmount),
    startDate: formatDate(startDate),
    startDateRaw: startDate,           // Date | null — used for date-range filtering
    endDate: formatDate(endDate),
    endDateRaw: endDate,               // Date | null — used for date-range filtering
    assignee: raw["BD/KAM Personnel code"] ?? raw["Assignee"] ?? raw["Owner"] ?? "Unassigned",
    workType: raw["Type of Work"] ?? raw["Work Type"] ?? "",
    _raw: raw, // kept internally for quality analysis
  };
}

export function cleanDeal(raw: Record<string, string>): Record<string, unknown> {
  const value = parseCurrency(
    raw["Masked Deal value"] ?? raw["Deal Value"] ?? raw["Value"] ?? raw["Amount"] ?? raw["Revenue"]
  );
  const closeDate = parseDate(
    raw["Tentative Close Date"] ?? raw["Close Date (A)"] ?? raw["Close Date"] ?? raw["Expected Close"]
  );
  const probRaw = raw["Closure Probability"] ?? raw["Probability"] ?? raw["Win Probability"] ?? "";
  const probNum = parseProbability(probRaw); // converts "High"→70, "Medium"→40, "Low"→15

  const stage = raw["Deal Stage"] ?? raw["Stage"] ?? "Unknown";
  // Filter out header rows that have the column name as the value
  const cleanStage = (stage === "Deal Stage") ? "Unknown" : stage;

  const isWon = ["G. Project Won", "Project Completed", "J. Invoice sent", "K. Amount Accrued"].includes(cleanStage);
  const isLost = ["L. Project Lost"].includes(cleanStage);
  const isOpen = !isWon && !isLost &&
    !["M. Projects On Hold", "N. Not relevant at the moment", "O. Not Relevant at all"].includes(cleanStage);

  return {
    id: raw.id,
    name: raw.name || "Unnamed Deal",
    stage: cleanStage,
    sector: normalizeSector(raw["Sector/service"] ?? raw["Sector"] ?? raw["Industry"] ?? raw["Vertical"]),
    client: raw["Client Code"] ?? raw["Client"] ?? raw["Account"] ?? raw["Company"] ?? "Unknown",
    dealValue: value ?? 0,
    dealValueFormatted: formatCurrency(value),
    probabilityRaw: probRaw,
    probabilityNumeric: probNum, // numeric value for weighted pipeline calculations
    probabilityDisplay: probNum !== null ? `${probNum}%` : (probRaw || "Unknown"),
    closeDate: formatDate(closeDate),
    closeDateRaw: closeDate,
    owner: raw["Owner code"] ?? raw["Owner"] ?? raw["Sales Rep"] ?? raw["Assignee"] ?? "Unassigned",
    product: raw["Product deal"] ?? "",
    isWon,
    isLost,
    isOpen,
    _raw: raw,
  };
}

// ─── Pre-Aggregation Functions ────────────────────────────────────────────

export interface DealsSummary {
  totalCount: number;
  dealsWithValue: number;
  dealsWithoutValue: number;
  totalValue: number;
  totalValueFormatted: string;
  openCount: number;
  openValue: number;
  openValueFormatted: string;
  wonCount: number;
  lostCount: number;
  winRate: string;
  weightedPipelineValue: number;
  weightedPipelineFormatted: string;
  avgDealSizeFormatted: string;
  stageBreakdown: Record<string, { count: number; value: number; formatted: string }>;
  sectorBreakdown: Record<string, { count: number; value: number; formatted: string }>;
}

export function summarizeDeals(deals: Record<string, unknown>[]): DealsSummary {
  let totalValue = 0;
  let openValue = 0;
  let openCount = 0;
  let wonCount = 0;
  let lostCount = 0;
  let valuedDealsCount = 0;
  let weightedPipeline = 0;

  const stageBreakdown: Record<string, { count: number; value: number; formatted: string }> = {};
  const sectorBreakdown: Record<string, { count: number; value: number; formatted: string }> = {};

  for (const d of deals) {
    const val = typeof d.dealValue === "number" ? d.dealValue : 0;
    const prob = typeof d.probabilityNumeric === "number" ? d.probabilityNumeric : null;

    if (val > 0) valuedDealsCount++;
    totalValue += val;

    if (d.isWon) wonCount++;
    if (d.isLost) lostCount++;
    if (d.isOpen) {
      openCount++;
      openValue += val;
      if (prob !== null) weightedPipeline += val * (prob / 100);
    }

    const stage = String(d.stage || "Unknown");
    const sector = String(d.sector || "Unknown");

    if (!stageBreakdown[stage]) stageBreakdown[stage] = { count: 0, value: 0, formatted: "" };
    stageBreakdown[stage].count++;
    stageBreakdown[stage].value += val;

    if (!sectorBreakdown[sector]) sectorBreakdown[sector] = { count: 0, value: 0, formatted: "" };
    sectorBreakdown[sector].count++;
    sectorBreakdown[sector].value += val;
  }

  for (const k in stageBreakdown) stageBreakdown[k].formatted = formatCurrency(stageBreakdown[k].value);
  for (const k in sectorBreakdown) sectorBreakdown[k].formatted = formatCurrency(sectorBreakdown[k].value);

  const closedTotal = wonCount + lostCount;
  const winRate = closedTotal > 0 ? `${((wonCount / closedTotal) * 100).toFixed(1)}%` : "N/A";
  const avgDealSize = valuedDealsCount > 0 ? totalValue / valuedDealsCount : 0;

  return {
    totalCount: deals.length,
    dealsWithValue: valuedDealsCount,
    dealsWithoutValue: deals.length - valuedDealsCount,
    totalValue,
    totalValueFormatted: formatCurrency(totalValue),
    openCount,
    openValue,
    openValueFormatted: formatCurrency(openValue),
    wonCount,
    lostCount,
    winRate,
    weightedPipelineValue: weightedPipeline,
    weightedPipelineFormatted: formatCurrency(weightedPipeline),
    avgDealSizeFormatted: formatCurrency(avgDealSize),
    stageBreakdown,
    sectorBreakdown,
  };
}

export interface WorkOrdersSummary {
  totalCount: number;
  completedCount: number;
  activeCount: number;
  onHoldCount: number;
  notStartedCount: number;
  overdueCount: number;
  totalContractValue: number;
  totalContractValueFormatted: string;
  completedContractValue: number;
  completedContractValueFormatted: string;
  totalBilledValue: number;
  totalBilledValueFormatted: string;
  collectionRate: string;
  statusBreakdown: Record<string, { count: number; value: number; formatted: string }>;
  sectorBreakdown: Record<string, { count: number; value: number; formatted: string }>;
}

export function summarizeWorkOrders(workOrders: Record<string, unknown>[]): WorkOrdersSummary {
  let totalContractValue = 0;
  let completedContractValue = 0;
  let totalBilledValue = 0;
  let completedCount = 0;
  let activeCount = 0;
  let onHoldCount = 0;
  let notStartedCount = 0;
  let overdueCount = 0;

  const statusBreakdown: Record<string, { count: number; value: number; formatted: string }> = {};
  const sectorBreakdown: Record<string, { count: number; value: number; formatted: string }> = {};

  for (const wo of workOrders) {
    const val = typeof wo.contractValue === "number" ? wo.contractValue : 0;
    const billed = typeof wo.billedValue === "number" ? wo.billedValue : 0;

    totalContractValue += val;
    totalBilledValue += billed;

    if (wo.isCompleted) { completedCount++; completedContractValue += val; }
    else if (wo.isActive) activeCount++;
    else if (String(wo.status).includes("Hold")) onHoldCount++;
    else if (String(wo.status) === "Not Started") notStartedCount++;

    if (wo.isOverdue) overdueCount++;

    const status = String(wo.status || "Unknown");
    const sector = String(wo.sector || "Unknown");

    if (!statusBreakdown[status]) statusBreakdown[status] = { count: 0, value: 0, formatted: "" };
    statusBreakdown[status].count++;
    statusBreakdown[status].value += val;

    if (!sectorBreakdown[sector]) sectorBreakdown[sector] = { count: 0, value: 0, formatted: "" };
    sectorBreakdown[sector].count++;
    sectorBreakdown[sector].value += val;
  }

  for (const k in statusBreakdown) statusBreakdown[k].formatted = formatCurrency(statusBreakdown[k].value);
  for (const k in sectorBreakdown) sectorBreakdown[k].formatted = formatCurrency(sectorBreakdown[k].value);

  const collectionRate = totalContractValue > 0
    ? `${((totalBilledValue / totalContractValue) * 100).toFixed(1)}%`
    : "N/A";

  return {
    totalCount: workOrders.length,
    completedCount,
    activeCount,
    onHoldCount,
    notStartedCount,
    overdueCount,
    totalContractValue,
    totalContractValueFormatted: formatCurrency(totalContractValue),
    completedContractValue,
    completedContractValueFormatted: formatCurrency(completedContractValue),
    totalBilledValue,
    totalBilledValueFormatted: formatCurrency(totalBilledValue),
    collectionRate,
    statusBreakdown,
    sectorBreakdown,
  };
}
