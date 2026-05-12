import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Settings, StatusReport, HotkeyMap } from "../../shared/types";
import type { SettingsBridge } from "../../preload/settings";

declare global {
  interface Window {
    api: SettingsBridge;
  }
}

type HotkeyKey = keyof HotkeyMap;
const HOTKEY_LABELS: Record<HotkeyKey, string> = {
  rateAgain: "Rate · Again (1)",
  rateHard: "Rate · Hard (2)",
  rateGood: "Rate · Good (3)",
  rateEasy: "Rate · Easy (4)",
  pause: "Pause / Resume",
  skip: "Skip / Next",
  replay: "Replay current source",
};

const captureAccelerator = (ev: KeyboardEvent): string | null => {
  const parts: string[] = [];
  if (ev.metaKey) parts.push("CommandOrControl");
  if (ev.ctrlKey && !ev.metaKey) parts.push("Control");
  if (ev.altKey) parts.push("Alt");
  if (ev.shiftKey) parts.push("Shift");
  // Skip if only modifiers
  const k = ev.key;
  if (["Meta", "Control", "Alt", "Shift"].includes(k)) return null;
  let key = k.length === 1 ? k.toUpperCase() : k;
  // Map a few common ones
  const map: Record<string, string> = {
    " ": "Space",
    Escape: "Escape",
    Enter: "Return",
    Tab: "Tab",
    Backspace: "Backspace",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
  };
  key = map[key] ?? key;
  parts.push(key);
  return parts.join("+");
};

function HotkeyCapture({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const [capturing, setCapturing] = useState(false);
  useEffect(() => {
    if (!capturing) return;
    const handler = (ev: KeyboardEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.key === "Escape") {
        setCapturing(false);
        return;
      }
      const accel = captureAccelerator(ev);
      if (accel) {
        onChange(accel);
        setCapturing(false);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [capturing, onChange]);
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      <span
        className={`hk-capture${capturing ? " capturing" : ""}`}
        onClick={() => setCapturing((c) => !c)}
      >
        {capturing ? "press a key…" : value || <em style={{ opacity: 0.5 }}>unbound</em>}
      </span>
      {value && (
        <span className="hk-clear" onClick={() => onChange("")}>
          clear
        </span>
      )}
    </span>
  );
}

function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<StatusReport | null>(null);
  const [decks, setDecks] = useState<string[]>([]);
  const [populateCount, setPopulateCount] = useState<number>(50);
  const [toast, setToast] = useState<string | null>(null);
  const [failedHotkeys, setFailedHotkeys] = useState<string[]>([]);
  const dirty = useRef(false);

  useEffect(() => {
    void window.api.getSettings().then(setSettings);
    void window.api.getStatus().then(setStatus);
    void window.api.listDecks().then(setDecks).catch(() => setDecks([]));
    const off1 = window.api.onStatus(setStatus);
    const off2 = window.api.onHotkeysFailed((failed) => {
      setFailedHotkeys(failed);
      showToast(`Failed to register: ${failed.join(", ")}`);
    });
    return () => {
      off1();
      off2();
    };
  }, []);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 2500);
  };

  const persist = async (patch: Partial<Settings>) => {
    const next = await window.api.updateSettings(patch);
    setSettings(next);
    showToast("saved");
  };

  if (!settings) return <div>loading…</div>;

  const updateHotkey = (key: HotkeyKey, value: string) => {
    void persist({ hotkeys: { ...settings.hotkeys, [key]: value } });
  };

  return (
    <div>
      <div className="status-bar">
        {status
          ? `${status.status} · ${status.dueCount} due · ${status.newToday} new today${status.generating ? " · generating…" : ""}`
          : "starting…"}
      </div>

      <h1>bgurbot</h1>

      <h2>Pacing</h2>
      <div className="row">
        <label>Pause before translation (s)</label>
        <input
          type="number"
          min={0}
          value={settings.pauseSeconds}
          onChange={(e) => persist({ pauseSeconds: Number(e.target.value) })}
        />
      </div>
      <div className="row">
        <label>Gap before next sentence (s)</label>
        <input
          type="number"
          min={0}
          value={settings.gapSeconds}
          onChange={(e) => persist({ gapSeconds: Number(e.target.value) })}
        />
      </div>
      <div className="row">
        <label>Auto-advance to next sentence</label>
        <label>
          <input
            type="checkbox"
            checked={settings.autoAdvance}
            onChange={(e) => persist({ autoAdvance: e.target.checked })}
          />{" "}
          when off, press the Skip hotkey to advance
        </label>
      </div>

      <h2>Decks</h2>
      <div className="row">
        <label>Vocab source deck</label>
        <select
          value={settings.vocabSourceDeck}
          onChange={(e) => persist({ vocabSourceDeck: e.target.value })}
        >
          {!decks.includes(settings.vocabSourceDeck) && (
            <option value={settings.vocabSourceDeck}>{settings.vocabSourceDeck}</option>
          )}
          {decks.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <label>bgbot deck name</label>
        <input
          type="text"
          value={settings.bgbotDeckName}
          onChange={(e) => persist({ bgbotDeckName: e.target.value })}
        />
      </div>
      <div className="row">
        <label>New cards per day</label>
        <input
          type="number"
          min={0}
          value={settings.newCardsPerDay}
          onChange={(e) => persist({ newCardsPerDay: Number(e.target.value) })}
        />
      </div>
      <div className="row">
        <label>Reviews per day</label>
        <input
          type="number"
          min={0}
          value={settings.reviewsPerDay}
          onChange={(e) => persist({ reviewsPerDay: Number(e.target.value) })}
        />
      </div>

      <h2>Hotkeys</h2>
      {(Object.keys(HOTKEY_LABELS) as HotkeyKey[]).map((k) => (
        <div className="row" key={k}>
          <label>
            {HOTKEY_LABELS[k]}
            {failedHotkeys.includes(settings.hotkeys[k]) && <span className="danger"> ⚠</span>}
          </label>
          <HotkeyCapture
            value={settings.hotkeys[k]}
            onChange={(v) => updateHotkey(k, v)}
          />
        </div>
      ))}

      <h2>Generate</h2>
      <div className="row">
        <label>One-shot populate</label>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            type="number"
            min={1}
            value={populateCount}
            onChange={(e) => setPopulateCount(Number(e.target.value))}
            style={{ width: 80 }}
          />
          <button
            onClick={async () => {
              showToast(`generating ${populateCount}…`);
              await window.api.runPopulate(populateCount);
              showToast(`generated ${populateCount}`);
            }}
          >
            Generate now
          </button>
        </div>
      </div>

      <h2>Loop</h2>
      <div className="row">
        <label>Manual control</label>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => window.api.controlLoop("pause")}>Pause</button>
          <button onClick={() => window.api.controlLoop("resume")}>Resume</button>
          <button onClick={() => window.api.controlLoop("skip")}>Skip</button>
          <button onClick={() => window.api.controlLoop("replay")}>Replay</button>
        </div>
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
