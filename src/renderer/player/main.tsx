import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  CardSnapshot,
  DayActivity,
  Ease,
  HistoryEntry,
  LoopStatus,
  ReplySuggestion,
  SessionProgress,
  Settings,
  StatsReport,
  StatusReport,
  TranslationLookup,
} from "../../shared/types";
import type { SettingsBridge } from "../../preload/settings";

declare global {
  interface Window {
    api: SettingsBridge;
  }
}

const EASE_LABELS: Record<Ease, string> = { 1: "Again", 2: "Hard", 3: "Good", 4: "Easy" };
const EASE_CLASSES: Record<Ease, string> = { 1: "again", 2: "hard", 3: "good", 4: "easy" };
const HISTORY_MAX = 50;

const statusText = (s: StatusReport): string => {
  if (s.status === "waitingRating") return "rate to continue";
  if (s.status === "doseComplete") return "done for today";
  return s.status;
};

const statusLine = (s: StatusReport | null): string => {
  if (!s) return "starting…";
  const parts = [statusText(s)];
  // Under welcome-back amnesty, drop the due-count framing entirely — the
  // banner does the talking and no backlog number should show anywhere.
  if (!s.session?.welcomeBack) parts.push(`${s.dueCount} due`);
  parts.push(`${s.newToday} new today`);
  if (s.generating) parts.push("generating…");
  return parts.join(" · ");
};

const historyKey = (e: HistoryEntry): string => `${e.snapshot.cardId}-${e.answeredAt}`;

const dotClass = (s: StatusReport | null): string => {
  if (!s) return "";
  if (s.status === "ankiUnreachable") return "error";
  if (s.status === "paused" || s.status === "idle") return "paused";
  return "active";
};

/** Urdu text with Roman transliteration underneath. */
function UrduText({ arabic, roman, compact }: { arabic: string; roman: string; compact?: boolean }) {
  return (
    <>
      {arabic && <div className="urdu">{arabic}</div>}
      {roman && <div className={compact ? "roman muted" : "roman"}>{roman}</div>}
    </>
  );
}

function CountdownBar({ status }: { status: StatusReport }) {
  const [progress, setProgress] = useState(1);
  const { phaseEndsAt, phaseDurationMs } = status;
  useEffect(() => {
    if (!phaseEndsAt || !phaseDurationMs) return;
    let raf = 0;
    const tick = () => {
      const remaining = Math.max(0, phaseEndsAt - Date.now());
      setProgress(Math.min(1, remaining / phaseDurationMs));
      if (remaining > 0) raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [phaseEndsAt, phaseDurationMs]);
  if (!phaseEndsAt || !phaseDurationMs) return null;
  return (
    <div className="countdown-track">
      <div className="countdown-fill" style={{ width: `${progress * 100}%` }} />
    </div>
  );
}

function CardPanel({
  card,
  status,
  revealed,
  onReveal,
}: {
  card: CardSnapshot;
  status: StatusReport | null;
  revealed: boolean;
  onReveal: () => void;
}) {
  const enToUr = card.direction === "en->ur";
  return (
    <div className="card-panel">
      <span className="direction-badge">{enToUr ? "English → Urdu" : "Urdu → English"}</span>

      {enToUr ? (
        <div className="sentence">{card.english}</div>
      ) : (
        <div>
          <UrduText arabic={card.urduArabic} roman={card.urduRoman} />
        </div>
      )}

      {status && <CountdownBar status={status} />}

      {revealed ? (
        <div className="translation">
          {enToUr ? (
            <UrduText arabic={card.urduArabic} roman={card.urduRoman} />
          ) : (
            <div className="sentence">{card.english}</div>
          )}
          {card.explanation && <div className="explanation">{card.explanation}</div>}
        </div>
      ) : (
        <div className="translation-hidden" onClick={onReveal}>
          translate it in your head — tap to reveal
        </div>
      )}
    </div>
  );
}

function Suggestions({ suggestions }: { suggestions: ReplySuggestion[] }) {
  return (
    <>
      <h2>You could reply…</h2>
      {suggestions.map((s, i) => (
        <div className="suggestion" key={i}>
          <div className="texts">
            <UrduText arabic={s.urduArabic} roman={s.urduRoman} compact />
            <div className="muted">{s.english}</div>
          </div>
          <button
            className="play-btn"
            title="Hear it"
            onClick={() =>
              void window.api.playOneOff({ text: s.urduArabic || s.urduRoman, lang: "ur-PK" })
            }
          >
            🔊
          </button>
        </div>
      ))}
    </>
  );
}

/** Ad-hoc Urdu↔English translation box, so lookups don't need Google Translate. */
function Lookup() {
  const [text, setText] = useState("");
  const [result, setResult] = useState<TranslationLookup | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const run = () => {
    const query = text.trim();
    if (!query || loading) return;
    setLoading(true);
    setError(false);
    void window.api
      .lookupTranslation(query)
      .then(setResult)
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  };

  // Whichever side is Urdu gets the speaker button.
  const urduText = result && (result.detected === "ur" ? result.input : result.translation);

  return (
    <>
      <h2>Look something up</h2>
      <div className="lookup-row">
        <input
          type="text"
          dir="auto"
          placeholder="Type Urdu or English…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") run();
          }}
        />
        <button onClick={run} disabled={loading || !text.trim()}>
          {loading ? "…" : "Translate"}
        </button>
      </div>
      {loading && <div className="muted lookup-note">translating…</div>}
      {error && !loading && <div className="lookup-error lookup-note">lookup failed — try again</div>}
      {result && !loading && !error && (
        <div className="suggestion">
          <div className="texts">
            {result.detected === "en" ? (
              <UrduText arabic={result.translation} roman={result.translationTranslit ?? ""} compact />
            ) : (
              <>
                {result.inputTranslit && <div className="roman muted">{result.inputTranslit}</div>}
                <div>{result.translation}</div>
              </>
            )}
          </div>
          {urduText && (
            <button
              className="play-btn"
              title="Hear the Urdu"
              onClick={() => void window.api.playOneOff({ text: urduText, lang: "ur-PK" })}
            >
              🔊
            </button>
          )}
        </div>
      )}
    </>
  );
}

function HistoryItem({ entry }: { entry: HistoryEntry }) {
  const [expanded, setExpanded] = useState(false);
  const { snapshot: c, ease } = entry;
  const enToUr = c.direction === "en->ur";
  const snippet = enToUr ? c.english : c.urduArabic || c.urduRoman;
  return (
    <div className="history-item" onClick={() => setExpanded((e) => !e)}>
      <div className="history-head">
        <span className="dir-mini">{enToUr ? "EN→UR" : "UR→EN"}</span>
        <span className={`history-snippet${enToUr ? "" : " urdu"}`}>{snippet}</span>
        <span className={`ease-badge ease-${ease}`}>{EASE_LABELS[ease]}</span>
      </div>
      {expanded && (
        <div className="history-detail" onClick={(e) => e.stopPropagation()}>
          <div className="history-line">
            <div className="texts sentence" style={{ fontSize: 14 }}>{c.english}</div>
            <button
              className="play-btn"
              title="Play English"
              onClick={() =>
                void window.api.playOneOff({ text: c.english, lang: "en-GB", soundField: c.englishAudio })
              }
            >
              🔊
            </button>
          </div>
          <div className="history-line">
            <div className="texts">
              <UrduText arabic={c.urduArabic} roman={c.urduRoman} compact />
            </div>
            <button
              className="play-btn"
              title="Play Urdu"
              onClick={() =>
                void window.api.playOneOff({
                  text: c.urduArabic || c.urduRoman,
                  lang: "ur-PK",
                  soundField: c.urduAudio,
                })
              }
            >
              🔊
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Slim daily-dose progress strip pinned under the status bar. Always rendered
 * (with graceful fallbacks while session/settings load) so the layout never
 * jumps when the data arrives.
 */
function DoseBar({ status, settings }: { status: StatusReport | null; settings: Settings | null }) {
  // Defensive: `session` can briefly be undefined against a stale main build.
  const session = status?.session;
  const answered = session?.answeredToday ?? 0;
  const target = session?.doseTarget ?? settings?.dailyDoseCards ?? 0;
  const pct = target > 0 ? Math.min(1, answered / target) : 0;
  return (
    <div className="dose">
      {session?.welcomeBack && (
        <div className="welcome-banner">
          Welcome back
          {session.daysAway != null && session.daysAway > 1 ? ` after ${session.daysAway} days` : ""} —
          easing you in with a short session
        </div>
      )}
      <div className="dose-row">
        <div
          className="dose-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={target || 1}
          aria-valuenow={Math.min(answered, target || answered)}
          aria-label="Daily dose progress"
        >
          <div className="dose-fill" style={{ width: `${pct * 100}%` }} />
        </div>
        <span className="dose-label">
          {answered} / {target > 0 ? target : "–"} today
        </span>
        {session?.ambient && <span className="ambient-tag">ambient mode</span>}
      </div>
    </div>
  );
}

/** Finish-line moment shown in place of the card when the dose is done. */
function DoseCompletePanel({
  session,
  stats,
  onDone,
  onKeepGoing,
}: {
  session: SessionProgress | undefined;
  stats: StatsReport | null;
  onDone: () => void;
  onKeepGoing: () => void;
}) {
  const n = session?.answeredToday ?? stats?.today?.answered ?? 0;
  return (
    <div className="card-panel celebrate">
      <div className="celebrate-mark" aria-hidden="true">
        ✓
      </div>
      <div className="celebrate-title">
        Done for today — {n} sentence{n === 1 ? "" : "s"}
      </div>
      {stats && (
        <div className="celebrate-stats">
          {stats.weekStreak > 0 && <span>{stats.weekStreak}-week streak</span>}
          <span>{stats.wordsKnown} sentences you know</span>
        </div>
      )}
      {stats && stats.recentMilestones.length > 0 && (
        <div className="milestone">🏅 {stats.recentMilestones[0]}</div>
      )}
      <div className="celebrate-actions">
        <button className="primary" onClick={onDone}>
          Done — see you tomorrow
        </button>
        <button onClick={onKeepGoing}>Keep going (ambient)</button>
      </div>
    </div>
  );
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Row index for a local YYYY-MM-DD date with Monday on top (0..6). */
const mondayRow = (isoDate: string): number => {
  const [y, m, d] = isoDate.split("-").map(Number);
  return (new Date(y, m - 1, d).getDay() + 6) % 7;
};

/** 26-week GitHub-style calendar heatmap: 7 rows (Mon top) × ~26 columns. */
function Heatmap({ days }: { days: DayActivity[] }) {
  if (days.length === 0) return null;
  const max = Math.max(1, ...days.map((d) => d.answered));
  // Pad the start so the first day lands on its weekday row.
  const offset = mondayRow(days[0].date);
  const cells: (DayActivity | null)[] = [...Array<null>(offset).fill(null), ...days];
  const cols = Math.ceil(cells.length / 7);

  // sqrt ramp: perceptually more even than linear for skewed counts.
  const level = (a: number): number =>
    a <= 0 ? 0 : Math.max(1, Math.min(4, Math.round(Math.sqrt(a / max) * 4)));

  // Month hint above the first column whose first day starts a new month.
  const labels: (string | null)[] = [];
  let prevMonth = -1;
  for (let c = 0; c < cols; c++) {
    let month = -1;
    for (let r = 0; r < 7; r++) {
      const cell = cells[c * 7 + r];
      if (cell) {
        month = Number(cell.date.slice(5, 7)) - 1;
        break;
      }
    }
    labels.push(month >= 0 && prevMonth >= 0 && month !== prevMonth ? MONTH_NAMES[month] : null);
    if (month >= 0) prevMonth = month;
  }

  const colStyle = { gridTemplateColumns: `repeat(${cols}, 6px)` };
  return (
    <div className="heatmap">
      <div className="hm-months" style={colStyle} aria-hidden="true">
        {labels.map((l, i) => (
          <span key={i}>{l ?? ""}</span>
        ))}
      </div>
      <div className="hm-grid" style={colStyle}>
        {cells.map((d, i) =>
          d ? (
            <span
              key={d.date}
              className={`hm-cell hm-${level(d.answered)}${d.doseMet ? " hm-met" : ""}`}
              title={`${d.date} · ${d.answered} answered${d.doseMet ? " · dose met ✓" : ""}`}
            />
          ) : (
            <span key={`pad-${i}`} className="hm-cell hm-pad" />
          ),
        )}
      </div>
    </div>
  );
}

function WeekPips({ stats }: { stats: StatsReport }) {
  const goal = Math.max(1, Math.min(7, stats.weeklyGoalDays || 5));
  const met = Math.max(0, Math.min(goal, stats.daysMetThisWeek));
  return (
    <div className="week-row">
      <span className="pips" role="img" aria-label={`${met} of ${goal} days this week`}>
        {Array.from({ length: goal }, (_, i) => (
          <span key={i} className={`pip${i < met ? " filled" : ""}`} />
        ))}
      </span>
      <span className="muted">
        {met}/{goal} days this week
      </span>
      {stats.weekStreak > 0 && <span className="streak">{stats.weekStreak}-week streak</span>}
    </div>
  );
}

function CompetenceRow({ stats }: { stats: StatsReport }) {
  const r7 = stats.recallRate7d;
  const r30 = stats.recallRate30d;
  const pct = (v: number): string => `${Math.round(v * 100)}%`;
  const trend: "up" | "down" | null =
    r7 != null && r30 != null && Math.abs(r7 - r30) >= 0.02 ? (r7 > r30 ? "up" : "down") : null;
  return (
    <div className="stat-lines">
      <div className="stat-line">
        <span className="muted">sentences you know</span>
        <span>{stats.wordsKnown}</span>
      </div>
      {r7 != null && (
        <div className="stat-line">
          <span className="muted">recall (7d)</span>
          <span>
            {pct(r7)}
            {trend && (
              <span
                className={`trend ${trend}`}
                title={r30 != null ? `vs ${pct(r30)} over 30 days` : undefined}
              >
                {" "}
                {trend === "up" ? "▲" : "▼"} vs 30d
              </span>
            )}
          </span>
        </div>
      )}
      <div className="stat-line">
        <span className="muted">total practised</span>
        <span>{stats.totalAnswered}</span>
      </div>
    </div>
  );
}

/** Collapsible progress block: heatmap, weekly goal pips, competence stats. */
function StatsSection({ stats }: { stats: StatsReport | null }) {
  const [open, setOpen] = useState(true);
  if (!stats) return null;
  return (
    <div className="stats-section">
      <button className="section-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Progress <span aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <>
          <Heatmap days={Array.isArray(stats.heatmap) ? stats.heatmap : []} />
          <WeekPips stats={stats} />
          <CompetenceRow stats={stats} />
        </>
      )}
    </div>
  );
}

function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [status, setStatus] = useState<StatusReport | null>(null);
  const [card, setCard] = useState<CardSnapshot | null>(null);
  const [manualReveal, setManualReveal] = useState(false);
  const [answerReached, setAnswerReached] = useState(false);
  const [rated, setRated] = useState<Ease | null>(null);
  const [suggestions, setSuggestions] = useState<ReplySuggestion[] | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [stats, setStats] = useState<StatsReport | null>(null);
  const cardIdRef = useRef<number | null>(null);
  const prevStatusRef = useRef<LoopStatus | null>(null);

  // Cheap aggregate call; guarded so a stale main build (no stats:get handler
  // yet) can't white-screen the player.
  const refreshStats = useCallback(() => {
    if (typeof window.api.getStats !== "function") return;
    void window.api
      .getStats()
      .then(setStats)
      .catch(() => {});
  }, []);

  useEffect(() => {
    void window.api.getSettings().then(setSettings);
    void window.api.getStatus().then(setStatus);
    void window.api.getCard().then(setCard);
    const offStatus = window.api.onStatus(setStatus);
    const offCard = window.api.onCard(setCard);
    const offHistory = window.api.onHistory((entry) => {
      setHistory((h) =>
        h.some((e) => historyKey(e) === historyKey(entry))
          ? h
          : [entry, ...h].slice(0, HISTORY_MAX),
      );
      refreshStats();
    });
    // Seed the session pane from persisted history instead of starting empty.
    if (typeof window.api.getRecentHistory === "function") {
      void window.api
        .getRecentHistory()
        .then((entries) => {
          if (!Array.isArray(entries)) return;
          setHistory((live) => {
            const seen = new Set(live.map(historyKey));
            const merged = [...live, ...entries.filter((e) => !seen.has(historyKey(e)))];
            merged.sort((a, b) => b.answeredAt - a.answeredAt);
            return merged.slice(0, HISTORY_MAX);
          });
        })
        .catch(() => {});
    }
    refreshStats();
    const statsTimer = setInterval(refreshStats, 5 * 60 * 1000);
    // Settings (e.g. suggestions toggle) may change in the settings window.
    const onFocus = () => void window.api.getSettings().then(setSettings);
    window.addEventListener("focus", onFocus);
    return () => {
      offStatus();
      offCard();
      offHistory();
      clearInterval(statsTimer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshStats]);

  // Re-pull stats once when the finish line is crossed (not on every status
  // update — those arrive constantly during playback).
  useEffect(() => {
    const st = status?.status ?? null;
    if (st === "doseComplete" && prevStatusRef.current !== "doseComplete") refreshStats();
    prevStatusRef.current = st;
  }, [status, refreshStats]);

  // Reset per-card state when a new card starts.
  useEffect(() => {
    const id = card?.cardId ?? null;
    if (id !== cardIdRef.current) {
      cardIdRef.current = id;
      setManualReveal(false);
      setAnswerReached(false);
      setRated(null);
      setSuggestions(null);
    }
  }, [card]);

  // The reveal is sticky: once the translation has played, stay revealed even
  // if the user replays the source afterwards.
  useEffect(() => {
    if (status?.status === "playingTranslation") setAnswerReached(true);
  }, [status]);

  const revealed = !!card && (manualReveal || answerReached);
  const suggestionsEnabled = settings?.suggestionsEnabled ?? false;

  // Fetch reply suggestions as soon as the card is known — the main process
  // prefetches them at card start, so this is usually an instant cache hit,
  // and starting early means the result lands while the card is still on
  // screen (fetching only at reveal meant slow generations resolved after the
  // card had advanced and were dropped by the cardIdRef guard, so they only
  // ever showed up when something kept the card around longer). They are held
  // in state but not rendered until `revealed` — showing them early would
  // spoil the translation.
  useEffect(() => {
    if (!card || !suggestionsEnabled || suggestions !== null) return;
    const forCard = card.cardId;
    void window.api.getSuggestions(card).then(
      (s) => {
        if (cardIdRef.current === forCard) setSuggestions(s);
      },
      () => {}, // IPC failure — leave null so the panel just stays hidden
    );
  }, [card, suggestionsEnabled, suggestions]);

  const paused = status?.status === "paused";

  const reveal = () => {
    setManualReveal(true);
    // Also cut the think-pause short so the audio catches up with the text.
    if (status?.status === "waitingPause") void window.api.controlLoop("replayTranslation");
  };

  const doRate = (ease: Ease) => {
    setRated(ease);
    void window.api.rate(ease);
  };

  return (
    <>
      <div className="status-bar">
        <span className={`status-dot ${dotClass(status)}`} />
        <span>{statusLine(status)}</span>
      </div>

      <DoseBar status={status} settings={settings} />

      <div className="scroll">
        {status?.status === "doseComplete" && !status.session?.ambient ? (
          <DoseCompletePanel
            session={status.session}
            stats={stats}
            onDone={() => void window.api.controlLoop("pause")}
            onKeepGoing={() => void window.api.controlLoop("skip")}
          />
        ) : card ? (
          <CardPanel card={card} status={status} revealed={revealed} onReveal={reveal} />
        ) : (
          <div className="card-panel">
            <div className="empty">
              {status?.status === "ankiUnreachable"
                ? "Anki is not reachable — open Anki desktop with AnkiConnect."
                : status?.status === "topUp" || status?.generating
                  ? "Generating new sentences…"
                  : "Waiting for the next card…"}
            </div>
          </div>
        )}

        <div className="controls">
          <button onClick={() => window.api.controlLoop(paused ? "resume" : "pause")}>
            {paused ? "Resume" : "Pause"}
          </button>
          <button disabled={!card} onClick={() => window.api.controlLoop("replay")} title="Replay the question audio">
            Replay Q
          </button>
          <button disabled={!card} onClick={() => window.api.controlLoop("replayTranslation")} title="Replay the answer audio">
            Replay A
          </button>
          <button onClick={() => window.api.controlLoop("skip")}>Skip</button>
        </div>

        <div className="ratings">
          {([1, 2, 3, 4] as Ease[]).map((ease) => (
            <button
              key={ease}
              disabled={!card}
              className={`${EASE_CLASSES[ease]}${rated === ease ? " selected" : ""}`}
              onClick={() => doRate(ease)}
            >
              {EASE_LABELS[ease]}
            </button>
          ))}
        </div>

        {revealed && suggestionsEnabled && suggestions && suggestions.length > 0 && (
          <Suggestions suggestions={suggestions} />
        )}

        <Lookup />

        <StatsSection stats={stats} />

        {history.length > 0 && (
          <>
            <h2>This session</h2>
            {history.map((entry) => (
              <HistoryItem key={`${entry.snapshot.cardId}-${entry.answeredAt}`} entry={entry} />
            ))}
          </>
        )}
      </div>

      <div className="footer">
        <span className="muted">bgurbot</span>
        <button title="Settings" onClick={() => void window.api.openSettings()}>
          ⚙
        </button>
      </div>
    </>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
