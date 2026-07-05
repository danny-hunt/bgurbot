/**
 * Learning stats: persists answered-card history to a small JSON file (same
 * pattern as costs.ts — path injected via initStatsStore so plain-Node
 * scripts could load it too) and derives streaks, heatmap data, and
 * competence metrics from it plus live Anki queries.
 */
import fs from "node:fs";
import path from "node:path";
import type { DayActivity, HistoryEntry, StatsReport } from "@shared/types";
import { getSettings } from "../settings";
import { AnkiService } from "./anki";

/** Per-day aggregate as stored (the date is the record key). */
interface DayAgg {
  answered: number;
  goodOrEasy: number;
  doseMet: boolean;
  /** Learner turns taken in role-play scenarios (kept out of recall rates). */
  scenarioTurns?: number;
}

interface MilestoneEvent {
  label: string;
  at: number; // epoch ms; 0 = back-filled silently (never shown as recent)
}

interface StatsState {
  days: Record<string, DayAgg>; // keyed by local YYYY-MM-DD
  history: HistoryEntry[]; // ring buffer, oldest first
  milestones: MilestoneEvent[];
  lastAnsweredAt: number | null;
}

const HISTORY_LIMIT = 200;
const HEATMAP_DAYS = 182; // 26 weeks
/** A day counts toward the weekly goal with this many answers even if the dose wasn't met. */
const MET_ANSWER_FLOOR = 10;
const ANKI_CACHE_MS = 60_000;

const MILESTONES: Array<{
  kind: "answered" | "known" | "streak";
  thresholds: number[];
  label: (n: number) => string;
}> = [
  {
    kind: "answered",
    thresholds: [50, 100, 250, 500, 1000, 2500, 5000],
    label: (n) => `${n} sentences practised`,
  },
  {
    kind: "known",
    thresholds: [10, 25, 50, 100, 250, 500],
    label: (n) => `${n} sentences you now know`,
  },
  {
    kind: "streak",
    thresholds: [2, 4, 8, 12, 26, 52],
    label: (n) => `${n}-week streak`,
  },
];

const emptyDay = (): DayAgg => ({ answered: 0, goodOrEasy: 0, doseMet: false });

let state: StatsState = { days: {}, history: [], milestones: [], lastAnsweredAt: null };
let filePath: string | null = null;
let saveTimer: NodeJS.Timeout | null = null;

const anki = new AnkiService();
let ankiCache: { at: number; wordsKnown: number; notesSeen: number } | null = null;

const dayKey = (d = new Date()): string => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const addDays = (d: Date, days: number): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);

/** Whole calendar days between two local YYYY-MM-DD keys (DST-safe). */
const dayDiff = (from: string, to: string): number => {
  const utc = (key: string): number => {
    const [y, m, d] = key.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(to) - utc(from)) / 86_400_000);
};

/** Monday of the week containing `d`, as a local date. */
const mondayOf = (d: Date): Date => addDays(d, -((d.getDay() + 6) % 7));

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
    if (state.history.length > HISTORY_LIMIT) {
      state.history = state.history.slice(-HISTORY_LIMIT);
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state));
  } catch (err) {
    console.warn("stats store: save failed", err);
  }
};

const scheduleSave = (): void => {
  if (!filePath || saveTimer) return;
  saveTimer = setTimeout(flush, 1000);
};

/** Load persisted stats from `file`; safe to call before any recordAnswer. */
export const initStatsStore = (file: string): void => {
  filePath = file;
  try {
    const loaded = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<StatsState>;
    const days = loaded.days ?? {};
    // Merge anything recorded before init (normally nothing) into the file state.
    for (const [day, agg] of Object.entries(state.days)) {
      const prev = days[day] ?? emptyDay();
      days[day] = {
        answered: prev.answered + agg.answered,
        goodOrEasy: prev.goodOrEasy + agg.goodOrEasy,
        doseMet: prev.doseMet || agg.doseMet,
      };
    }
    state = {
      days,
      history: [...(loaded.history ?? []), ...state.history].slice(-HISTORY_LIMIT),
      milestones: [...(loaded.milestones ?? []), ...state.milestones],
      lastAnsweredAt: Math.max(loaded.lastAnsweredAt ?? 0, state.lastAnsweredAt ?? 0) || null,
    };
  } catch {
    // No file yet — in-memory state is written on first save.
  }
  process.once("exit", flush); // sync flush even if the debounce is pending
};

const hasMilestone = (label: string): boolean =>
  state.milestones.some((m) => m.label === label);

/**
 * Record every threshold `value` has reached that isn't persisted yet, so it
 * never re-announces. Only the highest newly-crossed one gets a real
 * timestamp (shows as recent); lower ones are back-filled silently — e.g. a
 * fresh stats file over a mature Anki deck shouldn't announce 10/25/50 at once.
 */
const checkMilestones = (kind: "answered" | "known" | "streak", value: number): void => {
  const def = MILESTONES.find((m) => m.kind === kind)!;
  const crossed = def.thresholds
    .filter((t) => value >= t)
    .map(def.label)
    .filter((label) => !hasMilestone(label));
  if (crossed.length === 0) return;
  const now = Date.now();
  state.milestones.push(
    ...crossed.map((label, i) => ({ label, at: i === crossed.length - 1 ? now : 0 })),
  );
  scheduleSave();
};

const totalAnswered = (): number =>
  Object.values(state.days).reduce((sum, d) => sum + d.answered, 0);

/** Record one answered card. Called by the loop after each rating. */
export const recordAnswer = (entry: HistoryEntry): void => {
  const key = dayKey();
  const day = state.days[key] ?? emptyDay();
  day.answered += 1;
  if (entry.ease >= 3) day.goodOrEasy += 1;
  if (day.answered >= getSettings().dailyDoseCards) day.doseMet = true;
  state.days[key] = day;

  state.history.push(entry);
  if (state.history.length > HISTORY_LIMIT) {
    state.history = state.history.slice(-HISTORY_LIMIT);
  }
  state.lastAnsweredAt = entry.answeredAt;

  checkMilestones("answered", totalAnswered());
  checkMilestones("streak", weekStreak(getSettings().weeklyGoalDays));
  scheduleSave();
};

/**
 * Count a finished role-play toward today's activity. Scenario turns count
 * for showing up (weekly goal) but stay out of answered/goodOrEasy so card
 * recall rates aren't diluted.
 */
export const recordScenarioTurns = (turns: number): void => {
  if (turns <= 0) return;
  const key = dayKey();
  const day = state.days[key] ?? emptyDay();
  day.scenarioTurns = (day.scenarioTurns ?? 0) + turns;
  state.days[key] = day;
  state.lastAnsweredAt = Date.now();
  scheduleSave();
};

/** Cards answered so far today (local time), across restarts. */
export const getTodayAnsweredCount = (): number => state.days[dayKey()]?.answered ?? 0;

/**
 * Whole days since the user last answered a card (0 = active today),
 * or null if there is no recorded activity at all.
 */
export const getDaysSinceLastActivity = (): number | null => {
  const lastDay = Object.entries(state.days)
    .filter(([, d]) => d.answered > 0)
    .map(([key]) => key)
    .sort()
    .pop();
  if (!lastDay) return null;
  return Math.max(0, dayDiff(lastDay, dayKey()));
};

/** Most recent answered cards, newest first, for the player history pane. */
export const getRecentHistory = (limit = 50): HistoryEntry[] =>
  state.history.slice(-limit).reverse();

/** A day counts toward the weekly goal if the dose was met or activity hit the floor. */
const dayMet = (d: DayAgg | undefined): boolean =>
  !!d && (d.doseMet || d.answered + (d.scenarioTurns ?? 0) >= MET_ANSWER_FLOOR);

/** Met days in the Mon–Sun week starting at `monday`. */
const metDaysInWeek = (monday: Date): number => {
  let met = 0;
  for (let i = 0; i < 7; i++) {
    if (dayMet(state.days[dayKey(addDays(monday, i))])) met++;
  }
  return met;
};

/**
 * Consecutive weeks hitting the goal, counting backward from the current
 * week. The current week counts if it has already hit the goal, but an
 * in-progress week that hasn't yet doesn't break the streak.
 */
const weekStreak = (goal: number): number => {
  if (goal <= 0) return 0;
  let streak = 0;
  let monday = mondayOf(new Date());
  if (metDaysInWeek(monday) >= goal) streak++;
  for (;;) {
    monday = addDays(monday, -7);
    if (metDaysInWeek(monday) >= goal) streak++;
    else break;
  }
  return streak;
};

const toDayActivity = (date: string): DayActivity => {
  const d = state.days[date] ?? emptyDay();
  return { date, answered: d.answered, goodOrEasy: d.goodOrEasy, doseMet: d.doseMet };
};

/** goodOrEasy/answered over the trailing `days` days incl. today, or null. */
const recallRate = (days: number): number | null => {
  const today = new Date();
  let answered = 0;
  let good = 0;
  for (let i = 0; i < days; i++) {
    const d = state.days[dayKey(addDays(today, -i))];
    if (!d) continue;
    answered += d.answered;
    good += d.goodOrEasy;
  }
  return answered > 0 ? good / answered : null;
};

/** Anki-derived competence numbers, cached ~60s; zeros when Anki is unreachable. */
const fetchCompetence = async (): Promise<{ wordsKnown: number; notesSeen: number }> => {
  if (ankiCache && Date.now() - ankiCache.at < ANKI_CACHE_MS) return ankiCache;
  const deck = getSettings().bgbotDeckName;
  try {
    const [known, seen] = await Promise.all([
      anki.findNotes(`deck:"${deck}" prop:ivl>=21`),
      anki.findNotes(`deck:"${deck}" -is:new`),
    ]);
    ankiCache = { at: Date.now(), wordsKnown: known.length, notesSeen: seen.length };
    return ankiCache;
  } catch {
    // Unreachable: serve stale numbers if we have them, otherwise zeros.
    return ankiCache ?? { wordsKnown: 0, notesSeen: 0 };
  }
};

/**
 * Full report for the player dashboard. Async because competence metrics
 * (wordsKnown/notesSeen) query Anki; those fields fall back to 0 when Anki
 * is unreachable rather than failing the report.
 */
export const getStatsReport = async (): Promise<StatsReport> => {
  const settings = getSettings();
  const now = new Date();

  const heatmap: DayActivity[] = [];
  for (let i = HEATMAP_DAYS - 1; i >= 0; i--) {
    heatmap.push(toDayActivity(dayKey(addDays(now, -i))));
  }

  const streak = weekStreak(settings.weeklyGoalDays);
  const { wordsKnown, notesSeen } = await fetchCompetence();

  // Anki-derived milestones are checked lazily here; persisted so they never repeat.
  checkMilestones("known", wordsKnown);
  checkMilestones("streak", streak);

  const weekAgo = Date.now() - 7 * 86_400_000;
  const recentMilestones = state.milestones
    .filter((m) => m.at >= weekAgo)
    .sort((a, b) => b.at - a.at)
    .map((m) => m.label);

  return {
    today: toDayActivity(dayKey(now)),
    heatmap,
    weeklyGoalDays: settings.weeklyGoalDays,
    daysMetThisWeek: metDaysInWeek(mondayOf(now)),
    weekStreak: streak,
    daysSinceLastActivity: getDaysSinceLastActivity(),
    totalAnswered: totalAnswered(),
    wordsKnown,
    notesSeen,
    recallRate7d: recallRate(7),
    recallRate30d: recallRate(30),
    recentMilestones,
  };
};
