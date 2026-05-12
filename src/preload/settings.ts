import { contextBridge, ipcRenderer } from "electron";
import type { Settings, StatusReport } from "../shared/types";

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
  controlLoop: (action: "pause" | "resume" | "skip" | "replay") => Promise<void>;
  settingsPath: () => Promise<string>;
}

const bridge: SettingsBridge = {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (patch) => ipcRenderer.invoke("settings:update", patch),
  getStatus: () => ipcRenderer.invoke("status:get"),
  onStatus: (cb) => {
    const handler = (_e: unknown, s: StatusReport) => cb(s);
    ipcRenderer.on("status:update", handler);
    return () => ipcRenderer.removeListener("status:update", handler);
  },
  onHotkeysFailed: (cb) => {
    const handler = (_e: unknown, failed: string[]) => cb(failed);
    ipcRenderer.on("hotkeys:failed", handler);
    return () => ipcRenderer.removeListener("hotkeys:failed", handler);
  },
  testAnki: () => ipcRenderer.invoke("anki:test"),
  listDecks: () => ipcRenderer.invoke("anki:decks"),
  dueCount: () => ipcRenderer.invoke("anki:dueCount"),
  runPopulate: (count) => ipcRenderer.invoke("populate:run", count),
  controlLoop: (action) => ipcRenderer.invoke("loop:control", action),
  settingsPath: () => ipcRenderer.invoke("settings:path"),
};

contextBridge.exposeInMainWorld("api", bridge);
