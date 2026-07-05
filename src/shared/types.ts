export type LanguageCode = "ur-PK" | "en-GB";

export type VoiceName =
  | "ur-PK-UzmaNeural"
  | "ur-PK-AsadNeural"
  | "en-GB-RyanNeural"
  | "en-GB-LibbyNeural";

export interface GeneratedSentence {
  english: string;
  urduArabic: string;
  urduRoman: string;
  /** One brief AI-written sentence explaining the translation / grammar. */
  explanation?: string;
}

/** A conversational reply the learner could say in response to a sentence. */
export type ReplySuggestion = GeneratedSentence;

/** Result of an ad-hoc Urdu↔English lookup typed into the player's translate box. */
export interface TranslationLookup {
  input: string;
  detected: "ur" | "en";
  translation: string;
  /** Roman transliteration of the input, when the input is Urdu in Arabic script. */
  inputTranslit?: string;
  /** Roman transliteration of the translation, when the translation is Urdu. */
  translationTranslit?: string;
}

export type CardDirection = "en->ur" | "ur->en";

export type Ease = 1 | 2 | 3 | 4;

/** Everything a renderer needs to display the current card in either direction. */
export interface CardSnapshot {
  cardId: number;
  noteId: number;
  direction: CardDirection;
  english: string;
  urduArabic: string;
  urduRoman: string;
  /** Brief note explaining the translation and any grammar oddities. */
  explanation: string;
  /** Raw Anki sound fields ("[sound:...]"), so replays can reuse stored media. */
  englishAudio: string;
  urduAudio: string;
  /** Reply suggestions previously generated and stored on the note, if any. */
  suggestions?: ReplySuggestion[];
  startedAt: number;
}

/** Request to play a single piece of audio outside the loop (history/suggestions). */
export interface OneOffAudioRequest {
  text: string;
  lang: LanguageCode;
  /** Optional Anki sound field to prefer over TTS. */
  soundField?: string;
}

export interface HistoryEntry {
  snapshot: CardSnapshot;
  ease: Ease;
  answeredAt: number;
}

export interface HotkeyMap {
  rateAgain: string;
  rateHard: string;
  rateGood: string;
  rateEasy: string;
  pause: string;
  skip: string;
  replay: string;
  replayTranslation: string;
}

export interface Settings {
  pauseSeconds: number;
  autoAdvance: boolean;
  vocabSourceDeck: string;
  bgbotDeckName: string;
  newCardsPerDay: number;
  reviewsPerDay: number;
  suggestionsEnabled: boolean;
  /** Cards in the daily dose — the finite session with a finish line. */
  dailyDoseCards: number;
  /** Days per week that count as meeting the weekly consistency goal. */
  weeklyGoalDays: number;
  /** Cap comeback sessions and soften scary due counts after days away. */
  amnestyEnabled: boolean;
  /** Start bgurbot when logging in to macOS. */
  launchAtLogin: boolean;
  /** Local "HH:MM" (24h) for the daily reminder notification; empty = off. */
  dailyReminderTime: string;
  /** The user's if-then habit plan, e.g. "after I make my morning coffee". */
  habitAnchor: string;
  hotkeys: HotkeyMap;
}

export const DEFAULT_SETTINGS: Settings = {
  pauseSeconds: 10,
  autoAdvance: true,
  vocabSourceDeck: "Ling::Urdu",
  bgbotDeckName: "bgbot",
  // Kept low on purpose: every new card is future review debt, and review
  // debt is the #1 reason SRS habits die. The daily dose, not new-card
  // volume, is the throughput lever.
  newCardsPerDay: 15,
  reviewsPerDay: 9999,
  suggestionsEnabled: true,
  dailyDoseCards: 15,
  weeklyGoalDays: 5,
  amnestyEnabled: true,
  launchAtLogin: false,
  dailyReminderTime: "",
  habitAnchor: "",
  // Defaults assume a Hyper key (Caps Lock → Ctrl+Alt+Shift+Cmd via Hyperkey).
  hotkeys: {
    rateAgain: "Control+Alt+Shift+Command+1",
    rateHard: "Control+Alt+Shift+Command+2",
    rateGood: "Control+Alt+Shift+Command+3",
    rateEasy: "Control+Alt+Shift+Command+4",
    pause: "Control+Alt+Shift+Command+P",
    skip: "Control+Alt+Shift+Command+N",
    replay: "Control+Alt+Shift+Command+R",
    replayTranslation: "Control+Alt+Shift+Command+T",
  },
};

/** Raw metered usage of the third-party APIs for one aggregation window. */
export interface CostUsage {
  ttsChars: number;
  ttsCalls: number;
  openaiInputTokens: number;
  openaiOutputTokens: number;
  openaiCalls: number;
  translitChars: number;
  translitCalls: number;
}

/** USD pay-as-you-go list prices used to turn usage into estimated spend. */
export interface CostRates {
  ttsPerMillionChars: number;
  openaiInputPerMillionTokens: number;
  openaiOutputPerMillionTokens: number;
  translitPerMillionChars: number;
}

export interface CostBreakdown extends CostUsage {
  ttsCost: number;
  openaiCost: number;
  translitCost: number;
  totalCost: number;
}

export interface CostReport {
  today: CostBreakdown;
  thisMonth: CostBreakdown;
  allTime: CostBreakdown;
  /** ISO timestamp counters started accumulating (first use or last reset). */
  since: string;
  rates: CostRates;
}

export type LoopStatus =
  | "idle"
  | "paused"
  | "fetching"
  | "playingSource"
  | "waitingPause"
  | "playingTranslation"
  | "waitingRating"
  | "doseComplete"
  | "topUp"
  | "ankiUnreachable";

/** Where the user is in today's finite session. */
export interface SessionProgress {
  /** Cards answered today, persisted across restarts. */
  answeredToday: number;
  doseTarget: number;
  doseComplete: boolean;
  /** True once the user continues past the dose into open-ended listening. */
  ambient: boolean;
  /** Amnesty mode: a gently capped comeback session after days away. */
  welcomeBack: boolean;
  /** Days since the user last answered a card, when welcomeBack is set. */
  daysAway: number | null;
}

export interface StatusReport {
  status: LoopStatus;
  /**
   * Due count as it should be displayed. Under amnesty this is softened
   * (capped) — the true backlog number never leaves the loop.
   */
  dueCount: number;
  newToday: number;
  currentCardId: number | null;
  currentDirection: CardDirection | null;
  generating: boolean;
  /** When the current timed phase (waitingPause) ends, epoch ms. */
  phaseEndsAt: number | null;
  phaseDurationMs: number | null;
  session: SessionProgress;
  message?: string;
}

// ---------------------------------------------------------------------------
// Learning stats (persisted session history, streaks, competence)

/** Aggregate activity for one local day. */
export interface DayActivity {
  /** Local YYYY-MM-DD. */
  date: string;
  answered: number;
  /** Answers rated Good or Easy (ease >= 3). */
  goodOrEasy: number;
  /** Whether the daily dose target was met that day. */
  doseMet: boolean;
}

export interface StatsReport {
  today: DayActivity;
  /** Last 26 weeks of per-day activity, oldest first, zero-filled. */
  heatmap: DayActivity[];
  weeklyGoalDays: number;
  /** Active days so far this week (Mon–Sun). */
  daysMetThisWeek: number;
  /** Consecutive weeks hitting the weekly goal (incl. this one if met). */
  weekStreak: number;
  daysSinceLastActivity: number | null;
  totalAnswered: number;
  /** Notes with a card interval >= 21 days — "sentences you know". */
  wordsKnown: number;
  /** Notes reviewed at least once. */
  notesSeen: number;
  /** Share of answers rated Good/Easy over the trailing window. */
  recallRate7d: number | null;
  recallRate30d: number | null;
  /** Milestones crossed recently, newest first (human-readable). */
  recentMilestones: string[];
}
