interface AudioBridge {
  onPlay: (cb: (payload: { id: string; mp3Base64: string }) => void) => () => void;
  onStop: (cb: () => void) => () => void;
  reportFinished: (id: string) => void;
  reportError: (id: string, message: string) => void;
}
declare global {
  interface Window {
    audioBridge: AudioBridge;
  }
}

let currentEl: HTMLAudioElement | null = null;
let currentId: string | null = null;

const stopCurrent = () => {
  if (currentEl) {
    currentEl.pause();
    currentEl.src = "";
    currentEl = null;
  }
  currentId = null;
};

window.audioBridge.onPlay(({ id, mp3Base64 }) => {
  stopCurrent();
  const blob = new Blob([Uint8Array.from(atob(mp3Base64), (c) => c.charCodeAt(0))], {
    type: "audio/mpeg",
  });
  const url = URL.createObjectURL(blob);
  const el = new Audio(url);
  currentEl = el;
  currentId = id;
  el.onended = () => {
    URL.revokeObjectURL(url);
    if (currentId === id) {
      window.audioBridge.reportFinished(id);
      currentEl = null;
      currentId = null;
    }
  };
  el.onerror = () => {
    URL.revokeObjectURL(url);
    if (currentId === id) {
      window.audioBridge.reportError(id, "audio element error");
      currentEl = null;
      currentId = null;
    }
  };
  el.play().catch((err) => {
    if (currentId === id) {
      window.audioBridge.reportError(id, String(err?.message ?? err));
    }
  });
});

window.audioBridge.onStop(() => {
  stopCurrent();
});

console.log("audio renderer ready");
export {};
