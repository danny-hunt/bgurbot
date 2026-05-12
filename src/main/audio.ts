import { BrowserWindow, ipcMain } from "electron";
import { randomUUID } from "node:crypto";

let win: BrowserWindow | null = null;
const pending = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();

export const initAudioWindow = (htmlUrl: string, preloadPath: string): void => {
  if (win) return;
  win = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  void win.loadURL(htmlUrl);

  ipcMain.on("audio:finished", (_e, id: string) => {
    const p = pending.get(id);
    if (p) {
      pending.delete(id);
      p.resolve();
    }
  });
  ipcMain.on("audio:error", (_e, payload: { id: string; message: string }) => {
    const p = pending.get(payload.id);
    if (p) {
      pending.delete(payload.id);
      p.reject(new Error(payload.message));
    }
  });
};

/** Play one mp3 buffer; resolves when playback finishes or rejects on error. */
export const playAudio = (mp3: Buffer): Promise<void> => {
  if (!win) return Promise.reject(new Error("audio window not initialised"));
  const id = randomUUID();
  return new Promise<void>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    win!.webContents.send("audio:play", { id, mp3Base64: mp3.toString("base64") });
  });
};

export const stopAudio = (): void => {
  if (!win) return;
  win.webContents.send("audio:stop");
  for (const [, p] of pending) p.reject(new Error("stopped"));
  pending.clear();
};

export const destroyAudioWindow = (): void => {
  if (win) {
    win.destroy();
    win = null;
  }
};
