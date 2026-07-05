import { app, Tray, Menu, BrowserWindow, globalShortcut, ipcMain, nativeImage, dialog } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Loop } from "./loop";
import { initAudioWindow, destroyAudioWindow, playAudio, stopAudio } from "./audio";
import { getSettings, updateSettings, settingsPath } from "./settings";
import { AnkiService } from "./services/anki";
import { populate } from "./services/populate";
import { getReplySuggestions } from "./services/suggest";
import { lookupTranslation } from "./services/translate";
import { textToSpeech } from "./services/azure";
import { getCostReport, initCostStore, resetCosts } from "./services/costs";
import { getRecentHistory, getStatsReport, initStatsStore } from "./services/stats";
import { initReminder, rescheduleReminder } from "./services/reminder";
import type {
  CardSnapshot,
  Ease,
  HistoryEntry,
  OneOffAudioRequest,
  ReplySuggestion,
  Settings,
  StatusReport,
} from "@shared/types";

dotenv.config({ path: path.join(app.getAppPath(), ".env") });
dotenv.config(); // also try cwd

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RENDERER_DIR = path.join(__dirname, "..", "renderer");
const PRELOAD_DIR = path.join(__dirname, "..", "preload");

const audioHtmlUrl = `file://${path.join(RENDERER_DIR, "audio", "index.html")}`;
const audioPreload = path.join(PRELOAD_DIR, "audio.mjs");
const settingsHtmlUrl = `file://${path.join(RENDERER_DIR, "settings", "index.html")}`;
const settingsPreload = path.join(PRELOAD_DIR, "settings.mjs");
const playerHtmlUrl = `file://${path.join(RENDERER_DIR, "player", "index.html")}`;

let tray: Tray | null = null;
let settingsWindow: BrowserWindow | null = null;
let playerWindow: BrowserWindow | null = null;
const loop = new Loop();
let lastStatus: StatusReport | null = null;
let topUpInFlight = false;

const broadcast = (channel: string, payload: unknown) => {
  for (const win of [settingsWindow, playerWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
};

const broadcastStatus = (status: StatusReport) => {
  lastStatus = status;
  rebuildTrayMenu();
  broadcast("status:update", status);
};

loop.on("status", broadcastStatus);
loop.on("card", (snapshot: CardSnapshot | null) => broadcast("card:update", snapshot));
loop.on("history", (entry: HistoryEntry) => broadcast("history:append", entry));

const triggerTopUp = async (sentenceCount = 10) => {
  if (topUpInFlight) return;
  topUpInFlight = true;
  loop.setGenerating(true);
  const settings = getSettings();
  console.log(`Top-up: generating ${sentenceCount} sentences…`);
  try {
    await populate({
      vocabSourceDeck: settings.vocabSourceDeck,
      bgbotDeckName: settings.bgbotDeckName,
      totalSentences: sentenceCount,
      batchSize: 10,
      newPerDay: settings.newCardsPerDay,
      revPerDay: settings.reviewsPerDay,
      onProgress: (m) => console.log("[top-up]", m),
    });
  } catch (err) {
    console.error("Top-up failed:", err);
  } finally {
    topUpInFlight = false;
    loop.setGenerating(false);
  }
};

loop.setTopUpHandler(() => {
  void triggerTopUp(10);
});

const applyLoginItem = (settings: Settings) => {
  // In dev this would register the bare electron binary as a login item.
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin });
};

const registerHotkeys = (settings: Settings): { ok: boolean; failed: string[] } => {
  globalShortcut.unregisterAll();
  const failed: string[] = [];
  const tryRegister = (accel: string, fn: () => void) => {
    if (!accel) return;
    try {
      const ok = globalShortcut.register(accel, fn);
      if (!ok) failed.push(accel);
    } catch {
      failed.push(accel);
    }
  };
  tryRegister(settings.hotkeys.rateAgain, () => loop.rate(1));
  tryRegister(settings.hotkeys.rateHard, () => loop.rate(2));
  tryRegister(settings.hotkeys.rateGood, () => loop.rate(3));
  tryRegister(settings.hotkeys.rateEasy, () => loop.rate(4));
  tryRegister(settings.hotkeys.pause, () => loop.togglePause());
  tryRegister(settings.hotkeys.skip, () => loop.skip());
  tryRegister(settings.hotkeys.replay, () => loop.replay());
  tryRegister(settings.hotkeys.replayTranslation, () => loop.replayTranslation());
  return { ok: failed.length === 0, failed };
};

const openSettingsWindow = () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 720,
    height: 720,
    title: "bgurbot",
    webPreferences: {
      preload: settingsPreload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  void settingsWindow.loadURL(settingsHtmlUrl);
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
};

const openPlayerWindow = () => {
  if (playerWindow && !playerWindow.isDestroyed()) {
    playerWindow.show();
    playerWindow.focus();
    return;
  }
  playerWindow = new BrowserWindow({
    width: 360,
    height: 640,
    minWidth: 320,
    maxWidth: 440,
    minHeight: 480,
    title: "bgurbot",
    webPreferences: {
      preload: settingsPreload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  void playerWindow.loadURL(playerHtmlUrl);
  playerWindow.on("closed", () => {
    playerWindow = null;
  });
};

const rebuildTrayMenu = () => {
  if (!tray) return;
  const s = lastStatus;
  // Lead with dose progress, not the queue — the finish line is the point.
  const statusLine = s
    ? `${s.status} · ${s.session.answeredToday}/${s.session.doseTarget} today · ${s.dueCount} due${s.generating ? " · generating…" : ""}`
    : "starting…";
  const menu = Menu.buildFromTemplate([
    { label: statusLine, enabled: false },
    { type: "separator" },
    s?.status === "paused"
      ? { label: "Resume", click: () => loop.resume() }
      : { label: "Pause", click: () => loop.pause() },
    { label: "Skip current", click: () => loop.skip() },
    { label: "Replay current source", click: () => loop.replay() },
    { type: "separator" },
    { label: "Generate top-up now (10)", click: () => void triggerTopUp(10) },
    { label: "Open player window", click: () => openPlayerWindow() },
    { label: "Open settings…", click: () => openSettingsWindow() },
    { type: "separator" },
    { label: "Quit bgurbot", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`bgurbot — ${statusLine}`);
};

const initTray = () => {
  // Empty image + text title shows just the title in the macOS menu bar.
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setTitle("bg");
  rebuildTrayMenu();
};

// IPC: settings window <-> main
ipcMain.handle("settings:get", () => getSettings());
ipcMain.handle("settings:update", (_e, patch: Partial<Settings>) => {
  const next = updateSettings(patch);
  applyLoginItem(next);
  rescheduleReminder();
  const result = registerHotkeys(next);
  if (!result.ok && settingsWindow) {
    settingsWindow.webContents.send("hotkeys:failed", result.failed);
  }
  return next;
});
ipcMain.handle("status:get", () => loop.getStatus());
ipcMain.handle("settings:path", () => settingsPath());
ipcMain.handle("anki:test", async () => new AnkiService().testConnection());
ipcMain.handle("anki:decks", async () => new AnkiService().getDeckNames());
ipcMain.handle("anki:dueCount", async () => {
  const deck = getSettings().bgbotDeckName;
  return new AnkiService().countDueCards(deck);
});
ipcMain.handle("populate:run", async (_e, count: number) => {
  await triggerTopUp(count);
  return { ok: true };
});
ipcMain.handle(
  "loop:control",
  (_e, action: "pause" | "resume" | "skip" | "replay" | "replayTranslation") => {
    if (action === "pause") loop.pause();
    if (action === "resume") loop.resume();
    if (action === "skip") loop.skip();
    if (action === "replay") loop.replay();
    if (action === "replayTranslation") loop.replayTranslation();
  },
);
ipcMain.handle("loop:rate", (_e, ease: Ease) => loop.rate(ease));
ipcMain.handle("card:get", () => loop.getCurrentSnapshot());
ipcMain.handle("suggest:get", async (_e, snapshot?: CardSnapshot): Promise<ReplySuggestion[]> => {
  if (!getSettings().suggestionsEnabled) return [];
  const target = snapshot ?? loop.getCurrentSnapshot();
  if (!target) return [];
  return getReplySuggestions(target);
});
ipcMain.handle("translate:lookup", (_e, text: string) => lookupTranslation(text));
// One-off playback (history replay, tap-to-hear suggestions). Interrupts any
// audio the loop is currently playing by design.
ipcMain.handle("audio:playOneOff", async (_e, req: OneOffAudioRequest) => {
  let buf: Buffer | null = null;
  const filename = req.soundField?.match(/\[sound:([^\]]+)\]/)?.[1];
  if (filename) {
    buf = await new AnkiService().retrieveMediaFile(filename).catch(() => null);
  }
  if (!buf) {
    if (!req.text) return { ok: false };
    buf = await textToSpeech(req.text, req.lang);
  }
  stopAudio();
  try {
    await playAudio(buf);
    return { ok: true };
  } catch {
    return { ok: false }; // superseded by other playback — fine
  }
});
ipcMain.handle("settings:open", () => openSettingsWindow());
ipcMain.handle("costs:get", () => getCostReport());
ipcMain.handle("costs:reset", () => resetCosts());
ipcMain.handle("stats:get", () => getStatsReport());
ipcMain.handle("history:recent", () => getRecentHistory());

app.on("activate", () => {
  // dock icon click
  openPlayerWindow();
});

app.whenReady().then(async () => {
  initCostStore(path.join(app.getPath("userData"), "costs.json"));
  initStatsStore(path.join(app.getPath("userData"), "stats.json"));
  console.log("[bgurbot] ready; cwd =", process.cwd());
  console.log("[bgurbot] AZURE_SPEECH_KEY set?", !!process.env.AZURE_SPEECH_KEY);
  console.log("[bgurbot] settings file:", settingsPath());
  initAudioWindow(audioHtmlUrl, audioPreload);
  initTray();
  openPlayerWindow();

  const settings = getSettings();
  applyLoginItem(settings);
  initReminder({ getSettings, onActivate: () => openPlayerWindow() });
  const result = registerHotkeys(settings);
  if (!result.ok) {
    console.warn("Some hotkeys failed to register:", result.failed);
  }

  // Ensure model + deck options exist on startup so the deck is sane even
  // before the first generate-top-up.
  try {
    const anki = new AnkiService();
    if (await anki.testConnection()) {
      await anki.ensureModel();
      await anki.ensureDeckOptions(settings.bgbotDeckName, settings.newCardsPerDay, settings.reviewsPerDay);
    }
  } catch (err) {
    console.warn("Anki bootstrap failed:", err);
  }

  loop.start();
});

app.on("window-all-closed", () => {
  // Not calling app.quit() keeps the app (and the loop) alive when all
  // windows close.
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  loop.stop();
  destroyAudioWindow();
});
