import Store from "electron-store";
import { DEFAULT_SETTINGS, type Settings } from "@shared/types";

const store = new Store<Settings>({
  name: "settings",
  defaults: DEFAULT_SETTINGS,
});

export const getSettings = (): Settings => {
  // Merge stored values over defaults so newly-introduced fields get defaults.
  const stored = store.store;
  // Migration: stores written before hotkeys had real defaults hold all-empty
  // bindings, which would override the new defaults forever. If the user has
  // never customized any hotkey (all stored values empty/absent), ignore the
  // stored hotkeys so the defaults apply. Once any binding is non-empty the
  // stored map wins, so explicitly-cleared bindings stay cleared.
  const storedHotkeys = stored.hotkeys ?? {};
  const hasCustomHotkey = Object.values(storedHotkeys).some((v) => v !== "");
  const merged = {
    ...DEFAULT_SETTINGS,
    ...stored,
    hotkeys: hasCustomHotkey
      ? { ...DEFAULT_SETTINGS.hotkeys, ...storedHotkeys }
      : { ...DEFAULT_SETTINGS.hotkeys },
  };
  // Migration: the pre-daily-dose default of 200 new cards/day generates
  // unsustainable review debt. A stored value equal to that old default was
  // almost certainly never a deliberate choice, so let the new default win;
  // any other stored value is user intent and survives.
  if (stored.newCardsPerDay === 200) {
    merged.newCardsPerDay = DEFAULT_SETTINGS.newCardsPerDay;
  }
  return merged;
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
