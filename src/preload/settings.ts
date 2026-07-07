import { contextBridge, ipcRenderer } from "electron";
import type {
  AppNotice,
  CardSnapshot,
  CostReport,
  Ease,
  GeneratedSentence,
  HistoryEntry,
  OneOffAudioRequest,
  ReplySuggestion,
  ScenarioContext,
  ScenarioTurnResult,
  Settings,
  StatsReport,
  StatusReport,
  StoryPublicState,
  TopUpResult,
  TranslationLookup,
} from "../shared/types";

export type LoopAction = "pause" | "resume" | "skip" | "replay" | "replayTranslation";

/** Shared bridge for both the settings and player windows. */
export interface SettingsBridge {
  getSettings: () => Promise<Settings>;
  updateSettings: (patch: Partial<Settings>) => Promise<Settings>;
  getStatus: () => Promise<StatusReport>;
  onStatus: (cb: (status: StatusReport) => void) => () => void;
  onHotkeysFailed: (cb: (failed: string[]) => void) => () => void;
  /** Transient notices (generation results/failures) shown as toasts. */
  onNotify: (cb: (notice: AppNotice) => void) => () => void;
  testAnki: () => Promise<boolean>;
  listDecks: () => Promise<string[]>;
  dueCount: () => Promise<number>;
  runPopulate: (count: number) => Promise<TopUpResult>;
  controlLoop: (action: LoopAction) => Promise<void>;
  settingsPath: () => Promise<string>;
  // Player window
  getCard: () => Promise<CardSnapshot | null>;
  onCard: (cb: (snapshot: CardSnapshot | null) => void) => () => void;
  onHistory: (cb: (entry: HistoryEntry) => void) => () => void;
  rate: (ease: Ease) => Promise<void>;
  getSuggestions: (snapshot?: CardSnapshot) => Promise<ReplySuggestion[]>;
  lookupTranslation: (text: string) => Promise<TranslationLookup>;
  playOneOff: (req: OneOffAudioRequest) => Promise<{ ok: boolean }>;
  openSettings: () => Promise<void>;
  // Cost tracking
  getCosts: () => Promise<CostReport>;
  resetCosts: () => Promise<CostReport>;
  // Learning stats
  getStats: () => Promise<StatsReport>;
  getRecentHistory: () => Promise<HistoryEntry[]>;
  // Story serial
  getStory: () => Promise<StoryPublicState | null>;
  // Scenario role-plays (one active scenario at a time, held in main)
  scenarioContexts: () => Promise<ScenarioContext[]>;
  scenarioStart: (contextId: string) => Promise<ScenarioTurnResult>;
  /** Continue with the reply the learner chose (or typed). */
  scenarioReply: (reply: ReplySuggestion) => Promise<ScenarioTurnResult>;
  /** End (or abandon) the active scenario; records activity stats. */
  scenarioEnd: () => Promise<{ turns: number }>;
  /** Save a line from the scenario as a regular Anki card. */
  scenarioSave: (line: GeneratedSentence) => Promise<{ ok: boolean }>;
}

const subscribe = <T,>(channel: string) => (cb: (payload: T) => void) => {
  const handler = (_e: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

const bridge: SettingsBridge = {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (patch) => ipcRenderer.invoke("settings:update", patch),
  getStatus: () => ipcRenderer.invoke("status:get"),
  onStatus: subscribe<StatusReport>("status:update"),
  onHotkeysFailed: subscribe<string[]>("hotkeys:failed"),
  onNotify: subscribe<AppNotice>("notify"),
  testAnki: () => ipcRenderer.invoke("anki:test"),
  listDecks: () => ipcRenderer.invoke("anki:decks"),
  dueCount: () => ipcRenderer.invoke("anki:dueCount"),
  runPopulate: (count) => ipcRenderer.invoke("populate:run", count),
  controlLoop: (action) => ipcRenderer.invoke("loop:control", action),
  settingsPath: () => ipcRenderer.invoke("settings:path"),
  getCard: () => ipcRenderer.invoke("card:get"),
  onCard: subscribe<CardSnapshot | null>("card:update"),
  onHistory: subscribe<HistoryEntry>("history:append"),
  rate: (ease) => ipcRenderer.invoke("loop:rate", ease),
  getSuggestions: (snapshot) => ipcRenderer.invoke("suggest:get", snapshot),
  lookupTranslation: (text) => ipcRenderer.invoke("translate:lookup", text),
  playOneOff: (req) => ipcRenderer.invoke("audio:playOneOff", req),
  openSettings: () => ipcRenderer.invoke("settings:open"),
  getCosts: () => ipcRenderer.invoke("costs:get"),
  resetCosts: () => ipcRenderer.invoke("costs:reset"),
  getStats: () => ipcRenderer.invoke("stats:get"),
  getRecentHistory: () => ipcRenderer.invoke("history:recent"),
  getStory: () => ipcRenderer.invoke("story:state"),
  scenarioContexts: () => ipcRenderer.invoke("scenario:contexts"),
  scenarioStart: (contextId) => ipcRenderer.invoke("scenario:start", contextId),
  scenarioReply: (reply) => ipcRenderer.invoke("scenario:reply", reply),
  scenarioEnd: () => ipcRenderer.invoke("scenario:end"),
  scenarioSave: (line) => ipcRenderer.invoke("scenario:save", line),
};

contextBridge.exposeInMainWorld("api", bridge);
