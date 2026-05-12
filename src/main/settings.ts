import Store from "electron-store";
import { DEFAULT_SETTINGS, type Settings } from "@shared/types";

const store = new Store<Settings>({
  name: "settings",
  defaults: DEFAULT_SETTINGS,
});

export const getSettings = (): Settings => {
  // Merge stored values over defaults so newly-introduced fields get defaults.
  const stored = store.store;
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    hotkeys: { ...DEFAULT_SETTINGS.hotkeys, ...(stored.hotkeys ?? {}) },
  };
};

export const updateSettings = (patch: Partial<Settings>): Settings => {
  const next = { ...getSettings(), ...patch };
  if (patch.hotkeys) {
    next.hotkeys = { ...getSettings().hotkeys, ...patch.hotkeys };
  }
  store.set(next);
  return next;
};

export const settingsPath = (): string => store.path;
