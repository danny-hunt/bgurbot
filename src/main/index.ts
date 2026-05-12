import { app, Tray, Menu, BrowserWindow, globalShortcut, ipcMain, nativeImage, dialog } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Loop } from "./loop";
import { initAudioWindow, destroyAudioWindow } from "./audio";
import { getSettings, updateSettings, settingsPath } from "./settings";
import { AnkiService } from "./services/anki";
import { populate } from "./services/populate";
import type { Settings, StatusReport } from "@shared/types";

dotenv.config({ path: path.join(app.getAppPath(), ".env") });
dotenv.config(); // also try cwd

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RENDERER_DIR = path.join(__dirname, "..", "renderer");
const PRELOAD_DIR = path.join(__dirname, "..", "preload");

const audioHtmlUrl = `file://${path.join(RENDERER_DIR, "audio", "index.html")}`;
const audioPreload = path.join(PRELOAD_DIR, "audio.mjs");
const settingsHtmlUrl = `file://${path.join(RENDERER_DIR, "settings", "index.html")}`;
const settingsPreload = path.join(PRELOAD_DIR, "settings.mjs");

let tray: Tray | null = null;
let settingsWindow: BrowserWindow | null = null;
const loop = new Loop();
let lastStatus: StatusReport | null = null;
let topUpInFlight = false;

const broadcastStatus = (status: StatusReport) => {
  lastStatus = status;
  rebuildTrayMenu();
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send("status:update", status);
  }
};

loop.on("status", broadcastStatus);

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

const rebuildTrayMenu = () => {
  if (!tray) return;
  const s = lastStatus;
  const statusLine = s
    ? `${s.status} · ${s.dueCount} due · ${s.newToday} new today${s.generating ? " · generating…" : ""}`
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
ipcMain.handle("loop:control", (_e, action: "pause" | "resume" | "skip" | "replay") => {
  if (action === "pause") loop.pause();
  if (action === "resume") loop.resume();
  if (action === "skip") loop.skip();
  if (action === "replay") loop.replay();
});

app.dock?.hide(); // background app — no dock icon

app.whenReady().then(async () => {
  console.log("[bgurbot] ready; cwd =", process.cwd());
  console.log("[bgurbot] AZURE_SPEECH_KEY set?", !!process.env.AZURE_SPEECH_KEY);
  console.log("[bgurbot] settings file:", settingsPath());
  initAudioWindow(audioHtmlUrl, audioPreload);
  initTray();

  const settings = getSettings();
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

app.on("window-all-closed", (e: Event) => {
  // background app — keep alive when settings window closes
  e.preventDefault?.();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  loop.stop();
  destroyAudioWindow();
});
