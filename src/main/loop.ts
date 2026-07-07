import { EventEmitter } from "node:events";
import { AnkiService, type AnkiCardInfo } from "./services/anki";
import { textToSpeech } from "./services/azure";
import { getReplySuggestions, parseStoredSuggestions } from "./services/suggest";
import { playAudio, stopAudio } from "./audio";
import { getSettings } from "./settings";
import { getDaysSinceLastActivity, getTodayAnsweredCount, recordAnswer } from "./services/stats";
import { getPremiereCardIds, getPublicState } from "./services/story";
import type { CardSnapshot, Ease, EpisodeRef, HistoryEntry, LoopStatus, StatusReport } from "@shared/types";

interface CardWithDirection {
  card: AnkiCardInfo;
  snapshot: CardSnapshot;
  direction: "en->ur" | "ur->en";
  sourceText: string;
  translationText: string;
  sourceAudioField: string;
  translationAudioField: string;
  sourceAudio?: Buffer;
  translationAudio?: Buffer;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const extractFilename = (soundField: string): string | null => {
  const m = soundField.match(/\[sound:([^\]]+)\]/);
  return m ? m[1] : null;
};

/** Max cards in a welcome-back (amnesty) sitting after days away. */
const AMNESTY_CAP = 20;

/** Local YYYY-MM-DD — session state (dose, ambient, amnesty) is per-day. */
const localDayKey = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export class Loop extends EventEmitter {
  private anki = new AnkiService();
  private status: LoopStatus = "idle";
  private running = false;
  private paused = false;
  private generating = false;
  /** True due count from Anki. Never leaves the loop raw — see displayDueCount(). */
  private trueDueCount = 0;
  private newToday = 0;
  /** True once the user continues past the finish line into open-ended listening. */
  private ambient = false;
  /** Amnesty (welcome-back) mode: this sitting is capped at AMNESTY_CAP cards. */
  private welcomeBack = false;
  private daysAway: number | null = null;
  /** Cards answered this sitting — drives the amnesty cap and the one-shot emit. */
  private sittingAnswered = 0;
  /** Local day the session state belongs to; a new day resets the dose. */
  private sessionDay = localDayKey();
  /** Local day the one-shot "doseComplete" event was last emitted. */
  private doseCompleteEmittedDay: string | null = null;
  /** Set while today's story episode is premiering (played in story order). */
  private premiereEpisode: EpisodeRef | null = null;
  private current: CardWithDirection | null = null;
  private currentRating: Ease | null = null;
  private waitController: AbortController | null = null;
  private skipRequested = false;
  private replayRequested = false;
  private replayTranslationRequested = false;
  private phaseEndsAt: number | null = null;
  private phaseDurationMs: number | null = null;
  private lastPlayedAt = new Map<number, number>();
  private onTopUpNeeded?: () => void;

  setTopUpHandler(handler: () => void) {
    this.onTopUpNeeded = handler;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    void this.runLoop();
  }

  stop(): void {
    this.running = false;
    this.paused = false;
    this.abortWait();
    stopAudio();
    this.setStatus("idle");
  }

  pause(): void {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.abortWait();
    stopAudio();
    this.setStatus("paused");
  }

  resume(): void {
    if (!this.paused) {
      // Not paused: resume() while parked at the finish line means "keep
      // going" — opt into ambient mode and let the loop pick up cards again.
      if (this.running && this.status === "doseComplete") {
        this.ambient = true;
        this.abortWait();
      }
      return;
    }
    this.paused = false;
    if (this.running) {
      void this.runLoop();
    }
  }

  togglePause(): void {
    if (this.paused) this.resume();
    else this.pause();
  }

  skip(): void {
    this.skipRequested = true;
    this.abortWait();
    stopAudio();
  }

  replay(): void {
    if (!this.current) return;
    this.replayRequested = true;
    this.abortWait();
    stopAudio();
  }

  /**
   * Replay the translation side of the current card. During the think-pause
   * this cuts the pause short (i.e. "just tell me"); during/after the
   * translation it plays it again.
   */
  replayTranslation(): void {
    if (!this.current) return;
    this.replayTranslationRequested = true;
    this.abortWait();
    stopAudio();
  }

  rate(ease: Ease): void {
    if (!this.current) return;
    this.currentRating = ease;
    // A rating ends the card immediately, whatever phase it's in — same
    // teardown as skip() (abort waits, stop audio, let playCard unwind) but
    // the chosen rating is flushed to Anki instead of the skip default.
    this.abortWait();
    stopAudio();
    this.emitStatus(`rated ${["", "Again", "Hard", "Good", "Easy"][ease]}`);
  }

  setGenerating(v: boolean): void {
    this.generating = v;
    this.emitStatus();
  }

  getStatus(): StatusReport {
    const answeredToday = getTodayAnsweredCount();
    const doseTarget = getSettings().dailyDoseCards;
    return {
      status: this.paused ? "paused" : this.status,
      dueCount: this.displayDueCount(),
      newToday: this.newToday,
      currentCardId: this.current?.card.cardId ?? null,
      currentDirection: this.current?.direction ?? null,
      generating: this.generating,
      phaseEndsAt: this.phaseEndsAt,
      phaseDurationMs: this.phaseDurationMs,
      session: {
        episode: this.premiereEpisode,
        answeredToday,
        doseTarget,
        doseComplete: answeredToday >= doseTarget,
        ambient: this.ambient,
        welcomeBack: this.welcomeBack,
        daysAway: this.daysAway,
      },
    };
  }

  getCurrentSnapshot(): CardSnapshot | null {
    return this.current?.snapshot ?? null;
  }

  private setStatus(s: LoopStatus, message?: string): void {
    this.status = s;
    this.emitStatus(message);
  }

  private emitStatus(message?: string): void {
    const r = this.getStatus();
    if (message) r.message = message;
    this.emit("status", r);
  }

  private abortWait(): void {
    if (this.waitController) {
      this.waitController.abort();
      this.waitController = null;
    }
  }

  private async wait(ms: number): Promise<"done" | "aborted"> {
    this.waitController = new AbortController();
    const ctrl = this.waitController;
    try {
      await sleep(ms, ctrl.signal);
      return "done";
    } catch {
      return "aborted";
    } finally {
      if (this.waitController === ctrl) this.waitController = null;
    }
  }

  /**
   * Due count as it should be displayed. Under amnesty the number is
   * softened to what's left of the capped sitting, so the true backlog
   * never reaches the tray or player.
   */
  private displayDueCount(): number {
    if (!this.welcomeBack) return this.trueDueCount;
    return Math.min(this.trueDueCount, Math.max(0, AMNESTY_CAP - this.sittingAnswered));
  }

  /** New local day = new dose: drop ambient/amnesty state and the sitting counter. */
  private checkDayRollover(): void {
    const day = localDayKey();
    if (day === this.sessionDay) return;
    this.sessionDay = day;
    this.ambient = false;
    this.welcomeBack = false;
    this.daysAway = null;
    this.sittingAnswered = 0;
    this.premiereEpisode = null;
  }

  /**
   * True when the dose target (or the amnesty cap) has been reached and the
   * user hasn't opted into ambient listening — i.e. the loop should park at
   * the doseComplete state instead of fetching more cards.
   */
  private atFinishLine(): boolean {
    if (this.ambient) return false;
    if (getTodayAnsweredCount() >= getSettings().dailyDoseCards) return true;
    return this.welcomeBack && this.sittingAnswered >= AMNESTY_CAP;
  }

  /** Like wait(), but exposes the phase deadline in status for countdown UIs. */
  private async timedWait(status: LoopStatus, ms: number): Promise<"done" | "aborted"> {
    this.phaseEndsAt = Date.now() + ms;
    this.phaseDurationMs = ms;
    this.setStatus(status);
    const res = await this.wait(ms);
    this.phaseEndsAt = null;
    this.phaseDurationMs = null;
    return res;
  }

  private async runLoop(): Promise<void> {
    const deck = getSettings().bgbotDeckName;
    // A fresh runLoop is a new sitting (start, or resume after a pause).
    // Amnesty candidacy has to be decided now, before the first
    // recordAnswer makes days-since-activity read 0. An in-progress
    // welcome-back sitting keeps its counter so pausing can't extend the cap.
    this.checkDayRollover();
    if (!this.welcomeBack) this.sittingAnswered = 0;
    const daysAway = getDaysSinceLastActivity();
    let amnestyCandidate =
      !this.welcomeBack &&
      getSettings().amnestyEnabled &&
      daysAway !== null &&
      daysAway >= 3;
    while (this.running && !this.paused) {
      try {
        // Finish line: dose met (or amnesty cap hit) and the user hasn't
        // opted into ambient listening — park quietly instead of fetching
        // more cards (no top-up requests either). Also catches app start
        // with the dose already met today.
        this.checkDayRollover();
        if (this.atFinishLine()) {
          if (this.doseCompleteEmittedDay !== this.sessionDay) {
            this.doseCompleteEmittedDay = this.sessionDay;
            // Only celebrate a threshold crossed by this sitting; starting
            // the app with the dose already met parks quietly instead.
            if (this.sittingAnswered > 0) {
              this.emit("doseComplete", getTodayAnsweredCount());
            }
          }
          this.skipRequested = false;
          this.setStatus("doseComplete", "dose complete — done for today");
          // Same abortable-wait pattern as the manual-mode wait. skip() (or
          // resume()) is the "keep going" escape hatch into ambient mode.
          while (this.running && !this.paused && !this.ambient && !this.skipRequested) {
            if ((await this.wait(60_000)) === "aborted") break;
            this.checkDayRollover();
            if (!this.atFinishLine()) break; // new day (or raised dose) — carry on
          }
          if (this.skipRequested) {
            this.skipRequested = false;
            this.ambient = true;
          }
          if (this.ambient) {
            // Continuing past a capped comeback sitting ends the amnesty
            // framing — the user chose open-ended listening.
            this.welcomeBack = false;
            this.daysAway = null;
          }
          continue;
        }

        if (!(await this.anki.testConnection())) {
          this.setStatus("ankiUnreachable");
          // Back off and retry
          if ((await this.wait(5000)) === "aborted") continue;
          continue;
        }

        this.setStatus("fetching");
        const settings = getSettings();
        const dueIds = await this.anki.pickPlayableCards(
          deck,
          settings.newCardsPerDay,
          50,
        );
        this.trueDueCount = dueIds.length;
        // Amnesty: decided once, on the first fetch of the sitting, so a
        // mid-sitting backlog change can't flip the mode. Only a genuinely
        // scary backlog (> cap) after days away triggers welcome-back.
        if (amnestyCandidate) {
          amnestyCandidate = false;
          if (this.trueDueCount > AMNESTY_CAP) {
            this.welcomeBack = true;
            this.daysAway = daysAway;
            console.log(
              `[loop] welcome back after ${daysAway} days — sitting capped at ${AMNESTY_CAP} cards (true due ${this.trueDueCount})`,
            );
          }
        }
        this.newToday = await this.anki.countNewToday(deck).catch(() => 0);
        // Story premiere: today's episode plays first, in story order — the
        // lowest remaining card bypasses chooseNextCard's rotation. Rating,
        // recording, and the finish-line gate above all apply unchanged.
        let premiereId: number | null = null;
        try {
          premiereId = (await getPremiereCardIds(this.anki))[0] ?? null;
        } catch (err) {
          console.warn("[loop] premiere lookup failed", err);
        }
        this.premiereEpisode = premiereId !== null ? this.episodeRef() : null;
        this.emitStatus();
        console.log(`[loop] fetched ${dueIds.length} playable cards (newToday=${this.newToday})`);

        if (dueIds.length === 0 && premiereId === null) {
          // Only ask for a top-up when new cards can still be introduced
          // today. With the cap exhausted, freshly generated cards can't be
          // played, the queue stays empty, and the request would repeat
          // every 30s — a runaway generation loop. Park instead; a new day
          // (or newly due reviews) unparks it.
          if (this.newToday < settings.newCardsPerDay) {
            this.setStatus("topUp", "no due cards — requesting top-up");
            this.onTopUpNeeded?.();
            if ((await this.wait(30000)) === "aborted") continue;
          } else {
            this.setStatus("caughtUp", "caught up — nothing more to play today");
            if ((await this.wait(60_000)) === "aborted") continue;
          }
          continue;
        }

        const cards = await this.anki.getCardsInfo([premiereId ?? this.chooseNextCard(dueIds)]);
        const card = cards[0];
        if (!card) continue;
        const cardWithDir = this.buildCardWithDirection(card);
        if (!cardWithDir) continue;
        console.log(`[loop] playing card ${card.cardId} (${cardWithDir.direction}): "${cardWithDir.sourceText.slice(0, 50)}"`);
        this.lastPlayedAt.set(card.cardId, Date.now());
        this.current = cardWithDir;
        this.currentRating = null;
        this.skipRequested = false;
        this.replayRequested = false;
        this.replayTranslationRequested = false;
        this.emit("card", cardWithDir.snapshot);

        // Prefetch reply suggestions as soon as the card starts so the
        // renderer's fetch at reveal time is an instant cache hit (suggest.ts
        // caches per note and dedupes in-flight calls). Fire-and-forget; it
        // resolves [] on failure, but guard anyway so a rejection can't crash.
        if (settings.suggestionsEnabled) {
          void getReplySuggestions(cardWithDir.snapshot).catch(() => {});
        }

        await this.playCard(cardWithDir);

        const explicitlyRated = this.currentRating !== null;
        const skippedCard = this.skipRequested;

        // Pause/stop mid-card leaves the card untouched: no rating, no
        // history, no dose credit. It stays due and comes back on resume.
        if (!explicitlyRated && (this.paused || !this.running)) {
          this.current = null;
          this.currentRating = null;
          this.emit("card", null);
          continue;
        }

        if (explicitlyRated) {
          const ease: Ease = this.currentRating!;
          try {
            const answered = await this.anki.answerCards([{ cardId: card.cardId, ease }]);
            if (answered[0] === false) {
              console.warn(`[loop] answerCards returned false for card ${card.cardId} — rating not recorded`);
            }
            const entry: HistoryEntry = {
              snapshot: cardWithDir.snapshot,
              ease,
              answeredAt: Date.now(),
            };
            recordAnswer(entry);
            this.sittingAnswered += 1;
            this.emit("history", entry);
          } catch (err) {
            console.warn("answerCards failed", err);
          }
        }
        // Skipped without a rating: a real skip. Nothing is submitted to
        // Anki, nothing is recorded, and the dose doesn't advance — the
        // card just goes to the back of this session's rotation
        // (lastPlayedAt was stamped when it started).

        this.current = null;
        this.currentRating = null;
        this.emit("card", null);

        // Manual mode: wait for skip before fetching next. A rating or a
        // skip both mean "move on" and advance straight to the next card.
        // The finish line supersedes this wait — loop back so the dose gate
        // at the top parks the loop (and emits the one-shot) instead.
        if (!getSettings().autoAdvance && !explicitlyRated && !skippedCard && !this.atFinishLine()) {
          this.setStatus("idle", "waiting for next (skip hotkey)");
          while (this.running && !this.paused && !this.skipRequested) {
            if ((await this.wait(60_000)) === "aborted") break;
          }
          this.skipRequested = false;
        }
      } catch (err) {
        console.error("loop error:", err);
        if ((await this.wait(2000)) === "aborted") continue;
      }
    }
  }

  /** The premiering episode, for getStatus()'s session.episode. */
  private episodeRef(): EpisodeRef | null {
    const s = getPublicState();
    return s ? { number: s.episodeNumber, title: s.episodeTitle } : null;
  }

  /**
   * Pick a random card among the least-recently-played candidates. Rating a
   * card "Again" (the unattended default) puts it straight back into the due
   * queue, so always taking the first due card replays one phrase forever.
   * Never-played cards all tie at 0, so choosing randomly among the ties
   * scrambles the order sentences come up within a session instead of
   * following Anki's fixed due/new ordering.
   */
  private chooseNextCard(candidates: number[]): number {
    let bestTime = Infinity;
    for (const id of candidates) {
      const t = this.lastPlayedAt.get(id) ?? 0;
      if (t < bestTime) bestTime = t;
    }
    const ties = candidates.filter((id) => (this.lastPlayedAt.get(id) ?? 0) === bestTime);
    const best = ties[Math.floor(Math.random() * ties.length)];
    if (this.lastPlayedAt.size > 1000) {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const [id, t] of this.lastPlayedAt) {
        if (t < cutoff) this.lastPlayedAt.delete(id);
      }
    }
    return best;
  }

  private buildCardWithDirection(card: AnkiCardInfo): CardWithDirection | null {
    const f = card.fields;
    const english = f.English?.value ?? "";
    const urduArabic = f.UrduArabic?.value ?? "";
    const urduRoman = f.UrduRoman?.value ?? "";
    const englishAudio = f.EnglishAudio?.value ?? "";
    const urduAudio = f.UrduAudio?.value ?? "";
    const explanation = f.Explanation?.value ?? "";
    if (card.ord !== 0 && card.ord !== 1) return null;
    const direction = card.ord === 0 ? "en->ur" : "ur->en";
    const snapshot: CardSnapshot = {
      cardId: card.cardId,
      noteId: card.note,
      direction,
      english,
      urduArabic,
      urduRoman,
      explanation,
      englishAudio,
      urduAudio,
      suggestions: parseStoredSuggestions(f.Suggestions?.value ?? "") ?? undefined,
      startedAt: Date.now(),
    };
    if (direction === "en->ur") {
      // English → Urdu: source = English, translation = Urdu
      return {
        card,
        snapshot,
        direction,
        sourceText: english,
        translationText: urduArabic || urduRoman,
        sourceAudioField: englishAudio,
        translationAudioField: urduAudio,
      };
    }
    return {
      card,
      snapshot,
      direction,
      sourceText: urduArabic || urduRoman,
      translationText: english,
      sourceAudioField: urduAudio,
      translationAudioField: englishAudio,
    };
  }

  private async resolveAudio(soundField: string, fallbackText: string, language: "en-GB" | "ur-PK"): Promise<Buffer> {
    const filename = extractFilename(soundField);
    if (filename) {
      try {
        const buf = await this.anki.retrieveMediaFile(filename);
        if (buf) return buf;
      } catch (err) {
        console.warn("retrieveMediaFile failed; falling back to TTS", err);
      }
    }
    return textToSpeech(fallbackText, language);
  }

  private async playCard(c: CardWithDirection): Promise<void> {
    const settings = getSettings();
    const sourceLang = c.direction === "en->ur" ? "en-GB" : "ur-PK";
    const translationLang = c.direction === "en->ur" ? "ur-PK" : "en-GB";

    // Play source (re-playable via replay hotkey)
    while (true) {
      this.setStatus("playingSource");
      try {
        c.sourceAudio ??= await this.resolveAudio(c.sourceAudioField, c.sourceText, sourceLang);
        // Skip/rating may have arrived while the audio was being resolved
        // (nothing was playing for stopAudio to cut short).
        if (this.skipRequested || this.currentRating !== null || this.paused) return;
        await playAudio(c.sourceAudio);
      } catch (err) {
        if (this.replayRequested) {
          this.replayRequested = false;
          continue;
        }
        if (this.skipRequested || this.currentRating !== null || this.paused) return;
        console.warn("source playback error", err);
      }
      if (this.replayRequested) {
        this.replayRequested = false;
        continue;
      }
      break;
    }
    // A rating (like a skip) ends the card immediately, whatever phase it
    // arrived in.
    if (this.skipRequested || this.currentRating !== null || this.paused) return;

    // Pause before translation. replayTranslation here means "just tell me":
    // cut the pause short and go straight to the translation.
    if (!this.replayTranslationRequested) {
      await this.timedWait("waitingPause", settings.pauseSeconds * 1000);
      if (this.skipRequested || this.currentRating !== null || this.paused) return;
      if (this.replayRequested) {
        this.replayRequested = false;
        return this.playCard(c); // restart
      }
    }

    // Play translation, then the gap; both re-playable via replayTranslation.
    while (true) {
      this.replayTranslationRequested = false;
      this.setStatus("playingTranslation");
      try {
        c.translationAudio ??= await this.resolveAudio(c.translationAudioField, c.translationText, translationLang);
        // Skip/rating may have arrived while the audio was being resolved.
        if (this.skipRequested || this.currentRating !== null || this.paused) return;
        await playAudio(c.translationAudio);
      } catch (err) {
        if (this.replayTranslationRequested) continue;
        if (this.skipRequested || this.currentRating !== null || this.paused) return;
        console.warn("translation playback error", err);
      }
      if (this.replayTranslationRequested) continue;

      // Wait until the user rates the card (skip is the escape hatch and
      // falls back to the default rating). No countdown — wait indefinitely.
      if (this.currentRating === null) {
        this.setStatus("waitingRating", "rate to continue");
        while (
          this.running &&
          !this.paused &&
          this.currentRating === null &&
          !this.skipRequested &&
          !this.replayRequested &&
          !this.replayTranslationRequested
        ) {
          await this.wait(60_000);
        }
      }
      if (this.skipRequested || this.currentRating !== null || this.paused || !this.running) return;
      if (this.replayRequested) {
        this.replayRequested = false;
        return this.playCard(c); // restart from the source
      }
      if (this.replayTranslationRequested) continue;
      break;
    }
  }
}
