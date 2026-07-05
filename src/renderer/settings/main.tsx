import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CostBreakdown, CostReport, Settings, StatusReport, HotkeyMap } from "../../shared/types";
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
  replayTranslation: "Replay translation",
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

const fmtMoney = (v: number): string =>
  v > 0 && v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;

const fmtCount = (v: number): string =>
  v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M`
  : v >= 10_000 ? `${Math.round(v / 1000)}k`
  : v >= 1_000 ? `${(v / 1000).toFixed(1)}k`
  : String(v);

function CostsSection() {
  const [report, setReport] = useState<CostReport | null>(null);

  useEffect(() => {
    const refresh = () => void window.api.getCosts().then(setReport).catch(() => {});
    refresh();
    window.addEventListener("focus", refresh);
    const timer = setInterval(refresh, 30_000);
    return () => {
      window.removeEventListener("focus", refresh);
      clearInterval(timer);
    };
  }, []);

  if (!report) return null;
  const cols: Array<[string, CostBreakdown]> = [
    ["Today", report.today],
    ["This month", report.thisMonth],
    ["All time", report.allTime],
  ];
  const all = report.allTime;
  const rows: Array<[string, string, (b: CostBreakdown) => number]> = [
    ["Speech (TTS)", `${fmtCount(all.ttsChars)} chars · ${fmtCount(all.ttsCalls)} calls`, (b) => b.ttsCost],
    ["OpenAI (gpt-5-nano)", `${fmtCount(all.openaiInputTokens)} in / ${fmtCount(all.openaiOutputTokens)} out tokens · ${fmtCount(all.openaiCalls)} calls`, (b) => b.openaiCost],
    ["Translator", `${fmtCount(all.translitChars)} chars · ${fmtCount(all.translitCalls)} calls`, (b) => b.translitCost],
  ];
  const r = report.rates;

  return (
    <>
      <h2>API costs (estimated)</h2>
      <table className="costs">
        <thead>
          <tr>
            <th>Service</th>
            {cols.map(([label]) => (
              <th key={label}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, detail, pick]) => (
            <tr key={label}>
              <td>
                {label}
                <span className="costs-detail">{detail}</span>
              </td>
              {cols.map(([col, b]) => (
                <td key={col}>{fmtMoney(pick(b))}</td>
              ))}
            </tr>
          ))}
          <tr className="total">
            <td>Total</td>
            {cols.map(([col, b]) => (
              <td key={col}>{fmtMoney(b.totalCost)}</td>
            ))}
          </tr>
        </tbody>
      </table>
      <div className="costs-note">
        Estimated from metered usage × pay-as-you-go list prices (TTS ${r.ttsPerMillionChars}/M chars,
        gpt-5-nano ${r.openaiInputPerMillionTokens}/${r.openaiOutputPerMillionTokens} per M tokens in/out,
        Translator ${r.translitPerMillionChars}/M chars). Free-tier allowances are not reflected — check the
        Azure portal for billed amounts. Tracking since {new Date(report.since).toLocaleDateString()}.
      </div>
      <button
        onClick={async () => {
          if (!window.confirm("Reset all cost counters?")) return;
          setReport(await window.api.resetCosts());
        }}
      >
        Reset counters
      </button>
    </>
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

      <h2>Habit</h2>
      <div className="row">
        <label>Habit anchor</label>
        <div>
          <input
            type="text"
            placeholder="make my morning coffee"
            value={settings.habitAnchor}
            onChange={(e) => persist({ habitAnchor: e.target.value })}
          />
          <span className="hint">
            "After I ___, I'll do my daily dose." Writing down an if-then plan makes
            follow-through 2–3× more likely.
          </span>
        </div>
      </div>
      <div className="row">
        <label>Daily reminder</label>
        <div>
          <input
            type="time"
            value={settings.dailyReminderTime}
            onChange={(e) => persist({ dailyReminderTime: e.target.value })}
          />
          <span className="hint">one notification per day — clear it to turn off</span>
        </div>
      </div>
      <div className="row">
        <label>Daily dose</label>
        <div>
          <input
            type="number"
            min={1}
            value={settings.dailyDoseCards}
            onChange={(e) => persist({ dailyDoseCards: Number(e.target.value) })}
            style={{ width: 80 }}
          />
          <span className="hint">sentences per day — small enough to finish</span>
        </div>
      </div>
      <div className="row">
        <label>Weekly goal</label>
        <div>
          <input
            type="number"
            min={1}
            max={7}
            value={settings.weeklyGoalDays}
            onChange={(e) => persist({ weeklyGoalDays: Number(e.target.value) })}
            style={{ width: 80 }}
          />
          <span className="hint">days per week that count as a win</span>
        </div>
      </div>
      <div className="row">
        <label>Ease me back in after a break</label>
        <label>
          <input
            type="checkbox"
            checked={settings.amnestyEnabled}
            onChange={(e) => persist({ amnestyEnabled: e.target.checked })}
          />{" "}
          gentle, capped comeback sessions instead of a scary backlog
        </label>
      </div>
      <div className="row">
        <label>Start at login</label>
        <label>
          <input
            type="checkbox"
            checked={settings.launchAtLogin}
            onChange={(e) => persist({ launchAtLogin: e.target.checked })}
          />{" "}
          start bgurbot when you log in to macOS
        </label>
      </div>

      <h2>Story</h2>
      <div className="row">
        <label>Daily episode</label>
        <label>
          <input
            type="checkbox"
            checked={settings.storyEnabled}
            onChange={(e) => persist({ storyEnabled: e.target.checked })}
          />{" "}
          daily story episode as your new cards
        </label>
      </div>
      <div className="row">
        <label>About you — the story is built from this</label>
        <div>
          <textarea
            rows={5}
            value={settings.aboutMe}
            onChange={(e) => persist({ aboutMe: e.target.value })}
            // The stylesheet only styles inputs/selects — match them inline.
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "4px 6px",
              font: "inherit",
              fontSize: 13,
              color: "inherit",
              border: "1px solid rgba(128,128,128,0.4)",
              borderRadius: 4,
              background: "transparent",
              resize: "vertical",
            }}
          />
          <span className="hint">
            people, places, plans — the serial's protagonist and world come from here
          </span>
        </div>
      </div>

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
        <div>
          <input
            type="number"
            min={0}
            value={settings.newCardsPerDay}
            onChange={(e) => persist({ newCardsPerDay: Number(e.target.value) })}
            style={{ width: 80 }}
          />
          <span className="hint">
            every new card is future review debt — 10–20 keeps the habit sustainable
          </span>
        </div>
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

      <h2>Player</h2>
      <div className="row">
        <label>Reply suggestions</label>
        <label>
          <input
            type="checkbox"
            checked={settings.suggestionsEnabled}
            onChange={(e) => persist({ suggestionsEnabled: e.target.checked })}
          />{" "}
          suggest replies you could say (uses the LLM once per card)
        </label>
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

      <CostsSection />

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
