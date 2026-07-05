import { contextBridge, ipcRenderer } from "electron";
import type {
  CardSnapshot,
  CostReport,
  Ease,
  HistoryEntry,
  OneOffAudioRequest,
  ReplySuggestion,
  Settings,
  StatsReport,
  StatusReport,
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
  testAnki: () => Promise<boolean>;
  listDecks: () => Promise<string[]>;
  dueCount: () => Promise<number>;
  runPopulate: (count: number) => Promise<{ ok: boolean }>;
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
};

contextBridge.exposeInMainWorld("api", bridge);
