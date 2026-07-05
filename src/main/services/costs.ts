/**
 * Meters third-party API usage (Azure Speech TTS, Azure OpenAI, Azure
 * Translator transliteration) and estimates spend from list prices.
 *
 * Counters are aggregated per local day and persisted to a small JSON file.
 * The file path is injected via initCostStore() rather than derived from
 * Electron, because this module is also loaded by the populate CLI (plain
 * Node). Recording before init works — it accumulates in memory and is merged
 * into the file when init loads it.
 */
import fs from "node:fs";
import path from "node:path";
import type { CostBreakdown, CostRates, CostReport, CostUsage } from "@shared/types";

// USD pay-as-you-go list prices. Update here if Azure/OpenAI pricing changes;
// estimates only — free-tier allowances are not reflected.
export const COST_RATES: CostRates = {
  ttsPerMillionChars: 16, // Azure Speech, neural voices, per 1M characters
  openaiInputPerMillionTokens: 0.05, // gpt-5-nano input, per 1M tokens
  openaiOutputPerMillionTokens: 0.4, // gpt-5-nano output, per 1M tokens
  translitPerMillionChars: 10, // Azure Translator, per 1M characters
};

const EMPTY_USAGE: CostUsage = {
  ttsChars: 0,
  ttsCalls: 0,
  openaiInputTokens: 0,
  openaiOutputTokens: 0,
  openaiCalls: 0,
  translitChars: 0,
  translitCalls: 0,
};

interface CostState {
  since: string;
  days: Record<string, CostUsage>; // keyed by local YYYY-MM-DD
}

let state: CostState = { since: new Date().toISOString(), days: {} };
let filePath: string | null = null;
let saveTimer: NodeJS.Timeout | null = null;

const dayKey = (d = new Date()): string => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const addUsage = (a: CostUsage, b: Partial<CostUsage>): CostUsage => ({
  ttsChars: a.ttsChars + (b.ttsChars ?? 0),
  ttsCalls: a.ttsCalls + (b.ttsCalls ?? 0),
  openaiInputTokens: a.openaiInputTokens + (b.openaiInputTokens ?? 0),
  openaiOutputTokens: a.openaiOutputTokens + (b.openaiOutputTokens ?? 0),
  openaiCalls: a.openaiCalls + (b.openaiCalls ?? 0),
  translitChars: a.translitChars + (b.translitChars ?? 0),
  translitCalls: a.translitCalls + (b.translitCalls ?? 0),
});

const flush = (): void => {
  if (!filePath) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    // Keep the file bounded: drop days older than ~13 months.
    const keys = Object.keys(state.days).sort();
    while (keys.length > 400) {
      delete state.days[keys.shift()!];
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state));
  } catch (err) {
    console.warn("cost store: save failed", err);
  }
};

const scheduleSave = (): void => {
  if (!filePath || saveTimer) return;
  saveTimer = setTimeout(flush, 1000);
};

export const initCostStore = (file: string): void => {
  filePath = file;
  try {
    const loaded = JSON.parse(fs.readFileSync(file, "utf8")) as CostState;
    const days = loaded.days ?? {};
    // Merge anything recorded before init (normally nothing) into the file state.
    for (const [day, usage] of Object.entries(state.days)) {
      days[day] = addUsage(days[day] ?? EMPTY_USAGE, usage);
    }
    state = { since: loaded.since ?? state.since, days };
  } catch {
    // No file yet — in-memory state is written on first save.
  }
  process.once("exit", flush); // sync flush even if the debounce is pending
};

const bump = (patch: Partial<CostUsage>): void => {
  const key = dayKey();
  state.days[key] = addUsage(state.days[key] ?? EMPTY_USAGE, patch);
  scheduleSave();
};

export const recordTTS = (chars: number): void => bump({ ttsChars: chars, ttsCalls: 1 });
export const recordOpenAI = (inputTokens: number, outputTokens: number): void =>
  bump({ openaiInputTokens: inputTokens, openaiOutputTokens: outputTokens, openaiCalls: 1 });
export const recordTranslit = (chars: number): void =>
  bump({ translitChars: chars, translitCalls: 1 });

const toBreakdown = (u: CostUsage): CostBreakdown => {
  const ttsCost = (u.ttsChars / 1_000_000) * COST_RATES.ttsPerMillionChars;
  const openaiCost =
    (u.openaiInputTokens / 1_000_000) * COST_RATES.openaiInputPerMillionTokens +
    (u.openaiOutputTokens / 1_000_000) * COST_RATES.openaiOutputPerMillionTokens;
  const translitCost = (u.translitChars / 1_000_000) * COST_RATES.translitPerMillionChars;
  return { ...u, ttsCost, openaiCost, translitCost, totalCost: ttsCost + openaiCost + translitCost };
};

export const getCostReport = (): CostReport => {
  const today = dayKey();
  const month = today.slice(0, 7);
  let t = EMPTY_USAGE;
  let m = EMPTY_USAGE;
  let all = EMPTY_USAGE;
  for (const [day, u] of Object.entries(state.days)) {
    all = addUsage(all, u);
    if (day.startsWith(month)) m = addUsage(m, u);
    if (day === today) t = addUsage(t, u);
  }
  return {
    today: toBreakdown(t),
    thisMonth: toBreakdown(m),
    allTime: toBreakdown(all),
    since: state.since,
    rates: COST_RATES,
  };
};

export const resetCosts = (): CostReport => {
  state = { since: new Date().toISOString(), days: {} };
  flush();
  return getCostReport();
};
