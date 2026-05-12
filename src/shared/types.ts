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
}

export interface HotkeyMap {
  rateAgain: string;
  rateHard: string;
  rateGood: string;
  rateEasy: string;
  pause: string;
  skip: string;
  replay: string;
}

export interface Settings {
  pauseSeconds: number;
  gapSeconds: number;
  autoAdvance: boolean;
  vocabSourceDeck: string;
  bgbotDeckName: string;
  newCardsPerDay: number;
  reviewsPerDay: number;
  hotkeys: HotkeyMap;
}

export const DEFAULT_SETTINGS: Settings = {
  pauseSeconds: 10,
  gapSeconds: 5,
  autoAdvance: true,
  vocabSourceDeck: "Ling::Urdu",
  bgbotDeckName: "bgbot",
  newCardsPerDay: 200,
  reviewsPerDay: 9999,
  hotkeys: {
    rateAgain: "",
    rateHard: "",
    rateGood: "",
    rateEasy: "",
    pause: "",
    skip: "",
    replay: "",
  },
};

export type LoopStatus =
  | "idle"
  | "paused"
  | "fetching"
  | "playingSource"
  | "waitingPause"
  | "playingTranslation"
  | "waitingGap"
  | "topUp"
  | "ankiUnreachable";

export interface StatusReport {
  status: LoopStatus;
  dueCount: number;
  newToday: number;
  currentCardId: number | null;
  currentDirection: "en->ur" | "ur->en" | null;
  generating: boolean;
  message?: string;
}
