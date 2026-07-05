/**
 * Live scenario role-play pane (idea 8). Fully self-contained: styles are
 * injected from here (scen- prefix) so index.html stays untouched, and the
 * component only needs `window.api` plus an onExit callback from whoever
 * mounts it full-pane inside the player.
 *
 * Flow: pick a scenario (title + vision line) → conversation. The app speaks
 * each interlocutor line; the learner says a reply out loud, then taps which
 * suggested reply they used, and the next turn arrives from main.
 */
import React, { useEffect, useRef, useState } from "react";
import type {
  GeneratedSentence,
  ReplySuggestion,
  ScenarioContext,
  ScenarioTurnResult,
} from "@shared/types";
import type { SettingsBridge } from "../../preload/settings";

declare global {
  interface Window {
    api: SettingsBridge;
  }
}

const CSS = `
  .scen-root { display: flex; flex-direction: column; gap: 12px; }
  .scen-head { display: flex; align-items: center; gap: 8px; }
  .scen-head-title { flex: 1; font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .scen-turns { flex: none; font-size: 10.5px; opacity: 0.55; font-variant-numeric: tabular-nums; }
  .scen-exit {
    flex: none; border: 1px solid rgba(128,128,128,0.35); background: transparent; color: inherit;
    border-radius: 7px; padding: 4px 9px; cursor: pointer; font-size: 11px;
  }
  .scen-exit:hover { background: rgba(128,128,128,0.12); }

  .scen-vision {
    font-size: 12px; line-height: 1.5; font-style: italic; padding: 7px 10px;
    border-radius: 8px; background: rgba(91,141,239,0.12); border: 1px solid rgba(91,141,239,0.3);
  }

  .scen-pick { display: flex; flex-direction: column; gap: 8px; }
  .scen-ctx {
    display: flex; flex-direction: column; gap: 3px; width: 100%; text-align: left;
    border: 1px solid rgba(128,128,128,0.3); border-radius: 10px; padding: 9px 11px;
    background: transparent; color: inherit; cursor: pointer; font: inherit;
  }
  .scen-ctx:hover { background: rgba(128,128,128,0.08); }
  .scen-ctx-title { font-size: 13px; font-weight: 600; }
  .scen-ctx-vision { font-size: 11.5px; opacity: 0.65; line-height: 1.45; font-style: italic; }

  .scen-transcript { display: flex; flex-direction: column; gap: 8px; }
  .scen-bubble {
    max-width: 88%; border-radius: 12px; padding: 8px 11px;
    display: flex; flex-direction: column; gap: 2px;
  }
  .scen-them {
    align-self: flex-start; cursor: pointer;
    background: rgba(128,128,128,0.13); border: 1px solid rgba(128,128,128,0.2);
    border-bottom-left-radius: 4px;
  }
  .scen-them:hover { background: rgba(128,128,128,0.18); }
  .scen-learner {
    align-self: flex-end;
    background: rgba(91,141,239,0.16); border: 1px solid rgba(91,141,239,0.35);
    border-bottom-right-radius: 4px;
  }
  .scen-urdu { font-size: 18px; line-height: 1.85; direction: rtl; text-align: right; font-family: "Noto Nastaliq Urdu", "Geeza Pro", serif; }
  .scen-roman { font-size: 12px; opacity: 0.75; font-style: italic; }
  .scen-en { font-size: 11.5px; opacity: 0.6; line-height: 1.4; margin-top: 2px; }
  .scen-note { font-size: 11px; opacity: 0.55; line-height: 1.4; margin-top: 2px; }
  .scen-foot { display: flex; gap: 10px; align-items: center; margin-top: 3px; }
  .scen-mini {
    border: none; background: transparent; color: inherit; padding: 0;
    cursor: pointer; font-size: 10.5px; opacity: 0.55;
  }
  .scen-mini:hover { opacity: 0.9; }
  .scen-saved { font-size: 10.5px; color: #3aa557; }

  .scen-typing { display: flex; gap: 4px; align-items: center; padding: 4px 2px; }
  .scen-typing span {
    width: 5px; height: 5px; border-radius: 50%; background: currentColor;
    animation: scen-blink 1.2s infinite;
  }
  .scen-typing span:nth-child(2) { animation-delay: 0.2s; }
  .scen-typing span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes scen-blink { 0%, 80%, 100% { opacity: 0.2; } 40% { opacity: 0.85; } }

  .scen-guide { font-size: 11px; opacity: 0.6; text-align: center; }
  .scen-opts { display: flex; flex-direction: column; gap: 6px; }
  .scen-opt {
    display: flex; gap: 8px; align-items: flex-start; width: 100%; text-align: left;
    border: 1px solid rgba(128,128,128,0.3); border-radius: 9px; padding: 8px 10px;
    background: transparent; color: inherit; cursor: pointer; font: inherit;
  }
  .scen-opt:hover { background: rgba(91,141,239,0.1); border-color: rgba(91,141,239,0.5); }
  .scen-opt:disabled { opacity: 0.4; cursor: default; }
  .scen-opt-texts { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .scen-opt-roman { font-size: 14px; font-weight: 600; line-height: 1.4; }
  .scen-opt-en { font-size: 11.5px; opacity: 0.55; }
  .scen-icon { border: none; background: transparent; cursor: pointer; font-size: 14px; padding: 1px 3px; flex: none; opacity: 0.7; }
  .scen-icon:hover { opacity: 1; transform: scale(1.12); }

  .scen-done {
    display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center;
    border: 1px solid rgba(128,128,128,0.3); border-radius: 10px; padding: 16px 12px;
  }
  .scen-done-mark {
    width: 40px; height: 40px; border-radius: 50%; background: rgba(58,165,87,0.16); color: #3aa557;
    font-size: 22px; font-weight: 700; display: flex; align-items: center; justify-content: center;
  }
  .scen-done-title { font-size: 15px; font-weight: 600; }
  .scen-done-sub { font-size: 12px; opacity: 0.65; }
  .scen-primary {
    padding: 8px 14px; border-radius: 7px; border: 1px solid #3aa557; background: #3aa557;
    color: white; font-weight: 600; font-size: 12px; cursor: pointer; margin-top: 4px;
  }
  .scen-primary:hover { background: #349a50; }

  .scen-error {
    font-size: 12px; line-height: 1.45; padding: 8px 10px; border-radius: 8px;
    color: #e05252; border: 1px solid #e0525266; background: rgba(224,82,82,0.08);
  }
  .scen-empty { text-align: center; opacity: 0.5; padding: 18px 8px; font-size: 12px; }
`;

type Bubble = { who: "them" | "learner"; line: GeneratedSentence };
type SaveState = "saving" | "saved";

const lineKey = (l: GeneratedSentence): string => `${l.urduArabic}|${l.english}`;

const playLine = (line: GeneratedSentence): void => {
  const text = line.urduArabic || line.urduRoman;
  if (!text) return;
  void window.api.playOneOff({ text, lang: "ur-PK" }).catch(() => {});
};

const errMessage = (err: unknown): string => {
  const raw = err instanceof Error ? err.message : String(err);
  // ipcRenderer.invoke prefixes main-side throws; keep just the useful part.
  return raw.replace(/^Error invoking remote method '[^']+':\s*/, "").replace(/^Error:\s*/, "");
};

/** One interlocutor bubble: tap to replay, small english reveal, save. */
function ThemBubble({
  line,
  saveState,
  onSave,
}: {
  line: GeneratedSentence;
  saveState: SaveState | undefined;
  onSave: () => void;
}) {
  const [showEn, setShowEn] = useState(false);
  return (
    <div className="scen-bubble scen-them" onClick={() => playLine(line)} title="Tap to hear it again">
      {line.urduArabic && <div className="scen-urdu">{line.urduArabic}</div>}
      {line.urduRoman && <div className="scen-roman">{line.urduRoman}</div>}
      {showEn && (
        <>
          <div className="scen-en">{line.english}</div>
          {line.explanation && <div className="scen-note">{line.explanation}</div>}
        </>
      )}
      <div className="scen-foot" onClick={(e) => e.stopPropagation()}>
        <button className="scen-mini" onClick={() => setShowEn((s) => !s)}>
          {showEn ? "hide english" : "english?"}
        </button>
        {saveState === "saved" ? (
          <span className="scen-saved">✓ saved to deck</span>
        ) : (
          <button className="scen-mini" disabled={saveState === "saving"} onClick={onSave}>
            {saveState === "saving" ? "saving…" : "🔖 save"}
          </button>
        )}
      </div>
    </div>
  );
}

export const ScenarioView: React.FC<{ onExit: () => void }> = ({ onExit }) => {
  const [contexts, setContexts] = useState<ScenarioContext[] | null>(null);
  const [context, setContext] = useState<ScenarioContext | null>(null);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [options, setOptions] = useState<ReplySuggestion[]>([]);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [turnCount, setTurnCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Record<string, SaveState>>({});
  const endRef = useRef<HTMLDivElement | null>(null);
  const endedRef = useRef(false);

  // Guarded so a stale main build (handlers not registered yet) shows a
  // message instead of white-screening the pane.
  const bridgeOk = typeof window.api?.scenarioContexts === "function";

  useEffect(() => {
    if (!bridgeOk) return;
    void window.api
      .scenarioContexts()
      .then(setContexts)
      .catch((err) => setError(errMessage(err)));
  }, [bridgeOk]);

  // Keep the newest bubble / options in view as the conversation grows.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [bubbles, options, pending, done]);

  const applyTurn = (turn: ScenarioTurnResult): void => {
    setBubbles((b) => [...b, { who: "them", line: turn.them }]);
    setOptions(turn.options ?? []);
    setDone(turn.done);
    setTurnCount(turn.turnCount);
    playLine(turn.them); // auto-play each new line once, on arrival
  };

  const start = (ctx: ScenarioContext): void => {
    setContext(ctx);
    setPending(true);
    void window.api
      .scenarioStart(ctx.id)
      .then(applyTurn)
      .catch((err) => setError(errMessage(err)))
      .finally(() => setPending(false));
  };

  const choose = (option: ReplySuggestion): void => {
    if (pending) return;
    setBubbles((b) => [...b, { who: "learner", line: option }]);
    setOptions([]);
    setPending(true);
    void window.api
      .scenarioReply(option)
      .then(applyTurn)
      .catch((err) => setError(errMessage(err)))
      .finally(() => setPending(false));
  };

  const save = (line: GeneratedSentence): void => {
    const key = lineKey(line);
    if (saved[key]) return;
    setSaved((m) => ({ ...m, [key]: "saving" }));
    void window.api
      .scenarioSave(line)
      .then(() => setSaved((m) => ({ ...m, [key]: "saved" })))
      .catch(() => {
        // Back to a tappable save button; Anki was probably unreachable.
        setSaved((m) => {
          const next = { ...m };
          delete next[key];
          return next;
        });
      });
  };

  /** Leave the pane. Ends the active scenario in main exactly once. */
  const exit = (): void => {
    if (context && !endedRef.current && bridgeOk) {
      endedRef.current = true;
      void window.api.scenarioEnd().catch(() => {});
    }
    onExit();
  };

  const body = (): React.ReactNode => {
    if (!bridgeOk || error) {
      return (
        <>
          <div className="scen-error">
            {bridgeOk ? `Something went wrong: ${error}` : "Scenarios aren't available in this build."}
          </div>
          <button className="scen-exit" onClick={exit}>
            Back to reviews
          </button>
        </>
      );
    }

    // Picker: no scenario chosen yet.
    if (!context) {
      if (!contexts) return <div className="scen-empty">loading scenarios…</div>;
      return (
        <div className="scen-pick">
          {contexts.map((ctx) => (
            <button key={ctx.id} className="scen-ctx" onClick={() => start(ctx)}>
              <span className="scen-ctx-title">{ctx.title}</span>
              <span className="scen-ctx-vision">{ctx.vision}</span>
            </button>
          ))}
        </div>
      );
    }

    return (
      <>
        <div className="scen-vision">{context.vision}</div>

        <div className="scen-transcript">
          {bubbles.map((b, i) =>
            b.who === "them" ? (
              <ThemBubble
                key={i}
                line={b.line}
                saveState={saved[lineKey(b.line)]}
                onSave={() => save(b.line)}
              />
            ) : (
              <div key={i} className="scen-bubble scen-learner">
                {b.line.urduRoman && <div className="scen-roman">{b.line.urduRoman}</div>}
                <div className="scen-en">{b.line.english}</div>
              </div>
            ),
          )}
          {pending && (
            <div className="scen-bubble scen-them scen-typing" aria-label="generating…">
              <span /><span /><span />
            </div>
          )}
        </div>

        {done && !pending && (
          <div className="scen-done">
            <div className="scen-done-mark" aria-hidden="true">✓</div>
            <div className="scen-done-title">Scene complete</div>
            <div className="scen-done-sub">
              {turnCount} turn{turnCount === 1 ? "" : "s"} of live Urdu — {context.title.toLowerCase()}
            </div>
            <button className="scen-primary" onClick={exit}>
              Back to reviews
            </button>
          </div>
        )}

        {!done && !pending && options.length > 0 && (
          <>
            <div className="scen-guide">say it out loud, then tap what you said</div>
            <div className="scen-opts">
              {options.map((o, i) => (
                <button key={i} className="scen-opt" disabled={pending} onClick={() => choose(o)}>
                  <span className="scen-opt-texts">
                    <span className="scen-opt-roman">{o.urduRoman || o.urduArabic}</span>
                    <span className="scen-opt-en">{o.english}</span>
                  </span>
                  <span
                    className="scen-icon"
                    role="button"
                    title="Hear it"
                    onClick={(e) => {
                      e.stopPropagation();
                      playLine(o);
                    }}
                  >
                    🔊
                  </span>
                  {saved[lineKey(o)] === "saved" ? (
                    <span className="scen-saved">✓</span>
                  ) : (
                    <span
                      className="scen-icon"
                      role="button"
                      title="Save to deck"
                      onClick={(e) => {
                        e.stopPropagation();
                        save(o);
                      }}
                    >
                      🔖
                    </span>
                  )}
                </button>
              ))}
            </div>
          </>
        )}

        <div ref={endRef} />
      </>
    );
  };

  return (
    <div className="scen-root">
      <style>{CSS}</style>
      <div className="scen-head">
        <span className="scen-head-title">{context ? context.title : "Practise a scenario"}</span>
        {context && !done && <span className="scen-turns">turn {turnCount + 1}</span>}
        {!(done && context) && (
          <button className="scen-exit" onClick={exit}>
            {context ? "End" : "Back"}
          </button>
        )}
      </div>
      {body()}
    </div>
  );
};
