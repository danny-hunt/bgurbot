import { contextBridge, ipcRenderer } from "electron";

export interface AudioBridge {
  onPlay: (cb: (payload: { id: string; mp3Base64: string }) => void) => () => void;
  onStop: (cb: () => void) => () => void;
  reportFinished: (id: string) => void;
  reportError: (id: string, message: string) => void;
}

const onPlay = (cb: (payload: { id: string; mp3Base64: string }) => void) => {
  const handler = (_e: unknown, payload: { id: string; mp3Base64: string }) => cb(payload);
  ipcRenderer.on("audio:play", handler);
  return () => ipcRenderer.removeListener("audio:play", handler);
};

const onStop = (cb: () => void) => {
  const handler = () => cb();
  ipcRenderer.on("audio:stop", handler);
  return () => ipcRenderer.removeListener("audio:stop", handler);
};

const reportFinished = (id: string) => ipcRenderer.send("audio:finished", id);
const reportError = (id: string, message: string) => ipcRenderer.send("audio:error", { id, message });

contextBridge.exposeInMainWorld("audioBridge", {
  onPlay,
  onStop,
  reportFinished,
  reportError,
} satisfies AudioBridge);
