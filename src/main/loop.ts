import { EventEmitter } from "node:events";
import { AnkiService, type AnkiCardInfo } from "./services/anki";
import { textToSpeech } from "./services/azure";
import { playAudio, stopAudio } from "./audio";
import { getSettings } from "./settings";
import type { LoopStatus, StatusReport } from "@shared/types";

type Ease = 1 | 2 | 3 | 4;

interface CardWithDirection {
  card: AnkiCardInfo;
  direction: "en->ur" | "ur->en";
  sourceText: string;
  translationText: string;
  sourceAudioField: string;
  translationAudioField: string;
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

export class Loop extends EventEmitter {
  private anki = new AnkiService();
  private status: LoopStatus = "idle";
  private running = false;
  private paused = false;
  private generating = false;
  private dueCount = 0;
  private newToday = 0;
  private current: CardWithDirection | null = null;
  private currentRating: Ease | null = null;
  private waitController: AbortController | null = null;
  private skipRequested = false;
  private replayRequested = false;
  private nextWaitDeadline = 0; // for autoAdvance=false: wait until skip
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
    if (!this.paused) return;
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

  rate(ease: Ease): void {
    if (!this.current) return;
    this.currentRating = ease;
    this.emitStatus(`rated ${["", "Again", "Hard", "Good", "Easy"][ease]}`);
  }

  setGenerating(v: boolean): void {
    this.generating = v;
    this.emitStatus();
  }

  getStatus(): StatusReport {
    return {
      status: this.paused ? "paused" : this.status,
      dueCount: this.dueCount,
      newToday: this.newToday,
      currentCardId: this.current?.card.cardId ?? null,
      currentDirection: this.current?.direction ?? null,
      generating: this.generating,
    };
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

  private async runLoop(): Promise<void> {
    const deck = getSettings().bgbotDeckName;
    while (this.running && !this.paused) {
      try {
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
        this.dueCount = dueIds.length;
        this.newToday = await this.anki.countNewToday(deck).catch(() => 0);
        this.emitStatus();
        console.log(`[loop] fetched ${dueIds.length} playable cards (newToday=${this.newToday})`);

        if (dueIds.length === 0) {
          this.setStatus("topUp", "no due cards — requesting top-up");
          this.onTopUpNeeded?.();
          if ((await this.wait(30000)) === "aborted") continue;
          continue;
        }

        const cards = await this.anki.getCardsInfo([dueIds[0]]);
        const card = cards[0];
        if (!card) continue;
        const cardWithDir = this.buildCardWithDirection(card);
        if (!cardWithDir) continue;
        console.log(`[loop] playing card ${card.cardId} (${cardWithDir.direction}): "${cardWithDir.sourceText.slice(0, 50)}"`);
        this.current = cardWithDir;
        this.currentRating = null;
        this.skipRequested = false;
        this.replayRequested = false;

        await this.playCard(cardWithDir);

        // Submit rating (default Again if user didn't press anything)
        const ease: Ease = this.currentRating ?? 1;
        try {
          await this.anki.answerCards([{ cardId: card.cardId, ease }]);
        } catch (err) {
          console.warn("answerCards failed", err);
        }

        this.current = null;
        this.currentRating = null;

        // Manual mode: wait for skip before fetching next
        if (!getSettings().autoAdvance) {
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

  private buildCardWithDirection(card: AnkiCardInfo): CardWithDirection | null {
    const f = card.fields;
    const english = f.English?.value ?? "";
    const urduArabic = f.UrduArabic?.value ?? "";
    const urduRoman = f.UrduRoman?.value ?? "";
    const englishAudio = f.EnglishAudio?.value ?? "";
    const urduAudio = f.UrduAudio?.value ?? "";
    if (card.ord === 0) {
      // English → Urdu: source = English, translation = Urdu
      return {
        card,
        direction: "en->ur",
        sourceText: english,
        translationText: urduArabic || urduRoman,
        sourceAudioField: englishAudio,
        translationAudioField: urduAudio,
      };
    }
    if (card.ord === 1) {
      return {
        card,
        direction: "ur->en",
        sourceText: urduArabic || urduRoman,
        translationText: english,
        sourceAudioField: urduAudio,
        translationAudioField: englishAudio,
      };
    }
    return null;
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
        const audio = await this.resolveAudio(c.sourceAudioField, c.sourceText, sourceLang);
        await playAudio(audio);
      } catch (err) {
        if (this.replayRequested) {
          this.replayRequested = false;
          continue;
        }
        if (this.skipRequested || this.paused) return;
        console.warn("source playback error", err);
      }
      if (this.replayRequested) {
        this.replayRequested = false;
        continue;
      }
      break;
    }

    // Pause before translation
    this.setStatus("waitingPause");
    const pauseRes = await this.wait(settings.pauseSeconds * 1000);
    if (this.skipRequested || this.paused) return;
    if (this.replayRequested) {
      this.replayRequested = false;
      return this.playCard(c); // restart
    }
    if (pauseRes === "aborted") {
      // could be from skip/replay handled above; otherwise just continue
    }

    // Play translation
    this.setStatus("playingTranslation");
    try {
      const audio = await this.resolveAudio(c.translationAudioField, c.translationText, translationLang);
      await playAudio(audio);
    } catch (err) {
      if (this.skipRequested || this.paused) return;
      console.warn("translation playback error", err);
    }

    // Gap before next
    this.setStatus("waitingGap");
    await this.wait(settings.gapSeconds * 1000);
  }
}
