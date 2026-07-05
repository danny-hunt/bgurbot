/**
 * Talks to Anki via the AnkiConnect plugin (http://127.0.0.1:8765).
 */

export interface AnkiNoteInfo {
  noteId: number;
  modelName: string;
  tags: string[];
  fields: Record<string, { value: string; order: number }>;
  cards: number[];
  mod: number;
}

export interface AnkiCardInfo {
  cardId: number;
  fields: Record<string, { value: string }>;
  modelName: string;
  deckName: string;
  ord: number;
  note: number;
  type: number;
  queue: number;
  due: number;
  reps: number;
  lapses: number;
  factor: number;
  interval: number;
}

export interface AnkiNoteToAdd {
  deckName: string;
  modelName: string;
  fields: Record<string, string>;
  tags?: string[];
  audio?: Array<{ data: string; filename: string; fields: string[] }>;
  options?: { allowDuplicate?: boolean };
}

const shuffle = <T,>(arr: T[]): T[] => {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

export class AnkiService {
  static readonly MODEL_NAME = "BgbotSentence";
  static readonly OPTIONS_GROUP = "bgbot";
  private baseUrl = "http://127.0.0.1:8765";

  private async invoke<T = unknown>(action: string, params: unknown = {}): Promise<T> {
    const response = await fetch(this.baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, version: 6, params }),
    });
    if (!response.ok) throw new Error(`AnkiConnect HTTP ${response.status}`);
    const result = (await response.json()) as { result: T; error: string | null };
    if (result.error) throw new Error(`AnkiConnect: ${result.error}`);
    return result.result;
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.invoke("deckNames");
      return true;
    } catch {
      return false;
    }
  }

  async getDeckNames(): Promise<string[]> {
    return this.invoke<string[]>("deckNames");
  }

  async getModelNames(): Promise<string[]> {
    return this.invoke<string[]>("modelNames");
  }

  async createDeck(deckName: string): Promise<number> {
    return this.invoke<number>("createDeck", { deck: deckName });
  }

  async findCards(query: string): Promise<number[]> {
    return this.invoke<number[]>("findCards", { query });
  }

  async findNotes(query: string): Promise<number[]> {
    return this.invoke<number[]>("findNotes", { query });
  }

  async getDeckNotes(deckName: string): Promise<AnkiNoteInfo[]> {
    return this.invoke<AnkiNoteInfo[]>("notesInfo", {
      query: `deck:"${deckName}"`,
    });
  }

  async getCardsInfo(cardIds: number[]): Promise<AnkiCardInfo[]> {
    if (cardIds.length === 0) return [];
    return this.invoke<AnkiCardInfo[]>("cardsInfo", { cards: cardIds });
  }

  async retrieveMediaFile(filename: string): Promise<Buffer | null> {
    const result = await this.invoke<string | false>("retrieveMediaFile", { filename });
    if (!result) return null;
    return Buffer.from(result, "base64");
  }

  async addNotes(notes: AnkiNoteToAdd[]): Promise<Array<number | null>> {
    if (notes.length === 0) return [];
    return this.invoke<Array<number | null>>("addNotes", { notes });
  }

  async updateNoteFields(noteId: number, fields: Record<string, string>): Promise<void> {
    await this.invoke("updateNoteFields", { note: { id: noteId, fields } });
  }

  /** Submit ratings: ease 1=Again, 2=Hard, 3=Good, 4=Easy. */
  async answerCards(answers: Array<{ cardId: number; ease: 1 | 2 | 3 | 4 }>): Promise<boolean[]> {
    if (answers.length === 0) return [];
    return this.invoke<boolean[]>("answerCards", { answers });
  }

  /**
   * Cards that should be shown next: review-due cards first, then unseen new
   * cards (subject to the daily new-cards cap). Both pools are shuffled so
   * the session doesn't replay cards in Anki's fixed due/new ordering.
   */
  async pickPlayableCards(
    deckName: string,
    newCardsPerDay: number,
    limit = 50,
  ): Promise<number[]> {
    const dueIds = shuffle(
      await this.invoke<number[]>("findCards", {
        query: `deck:"${deckName}" is:due`,
      }),
    );
    if (dueIds.length >= limit) return dueIds.slice(0, limit);

    const newToday = await this.countNewToday(deckName);
    const remaining = Math.max(0, newCardsPerDay - newToday);
    if (remaining === 0) return dueIds;

    const newIds = shuffle(
      await this.invoke<number[]>("findCards", {
        query: `deck:"${deckName}" is:new`,
      }),
    );
    return [...dueIds, ...newIds.slice(0, remaining)].slice(0, limit);
  }

  async countDueCards(deckName: string): Promise<number> {
    const ids = await this.invoke<number[]>("findCards", {
      query: `deck:"${deckName}" is:due`,
    });
    return ids.length;
  }

  async countNewToday(deckName: string): Promise<number> {
    const ids = await this.invoke<number[]>("findCards", {
      query: `deck:"${deckName}" introduced:1`,
    });
    return ids.length;
  }

  /**
   * Create the BgbotSentence model if it doesn't exist. Two card templates so
   * each note generates an English→Urdu card and an Urdu→English card. If the
   * model exists from an older version without the Explanation field, add the
   * field and refresh the templates in place.
   */
  async ensureModel(): Promise<void> {
    const explanationHtml =
      '{{#Explanation}}<div class="expl">{{Explanation}}</div>{{/Explanation}}';
    const templates = {
      "English → Urdu": {
        Front: "{{English}}<br>{{EnglishAudio}}",
        Back: `{{FrontSide}}<hr id=answer>{{UrduArabic}}<br>{{UrduRoman}}<br>{{UrduAudio}}${explanationHtml}`,
      },
      "Urdu → English": {
        Front: "{{UrduArabic}}<br>{{UrduRoman}}<br>{{UrduAudio}}",
        Back: `{{FrontSide}}<hr id=answer>{{English}}<br>{{EnglishAudio}}${explanationHtml}`,
      },
    };

    const names = await this.getModelNames();
    if (!names.includes(AnkiService.MODEL_NAME)) {
      await this.invoke("createModel", {
        modelName: AnkiService.MODEL_NAME,
        inOrderFields: ["English", "UrduArabic", "UrduRoman", "EnglishAudio", "UrduAudio", "Explanation", "Suggestions"],
        css: [
          ".card { font-family: sans-serif; font-size: 22px; text-align: center; }",
          ".expl { font-size: 15px; color: #888; margin-top: 12px; }",
        ].join("\n"),
        isCloze: false,
        cardTemplates: Object.entries(templates).map(([Name, t]) => ({ Name, ...t })),
      });
      return;
    }

    const fields = await this.invoke<string[]>("modelFieldNames", {
      modelName: AnkiService.MODEL_NAME,
    });
    // Suggestions holds app-generated JSON; deliberately absent from templates.
    const hadExplanation = fields.includes("Explanation");
    for (const missing of ["Explanation", "Suggestions"].filter((f) => !fields.includes(f))) {
      await this.invoke("modelFieldAdd", {
        modelName: AnkiService.MODEL_NAME,
        fieldName: missing,
        index: fields.length,
      });
      fields.push(missing);
    }
    if (!hadExplanation) {
      await this.invoke("updateModelTemplates", {
        model: { name: AnkiService.MODEL_NAME, templates },
      });
      await this.invoke("updateModelStyling", {
        model: {
          name: AnkiService.MODEL_NAME,
          css: [
            ".card { font-family: sans-serif; font-size: 22px; text-align: center; }",
            ".expl { font-size: 15px; color: #888; margin-top: 12px; }",
          ].join("\n"),
        },
      }).catch(() => undefined); // styling is cosmetic; ignore older AnkiConnect
    }
  }

  /**
   * Ensure the bgbot deck exists with a dedicated options group whose new/review
   * caps match the user's settings. Idempotent — safe to run on every startup.
   */
  async ensureDeckOptions(deckName: string, newPerDay: number, revPerDay: number): Promise<void> {
    await this.createDeck(deckName);
    const allConfigs = await this.invoke<Array<{ id: number; name: string }>>(
      "getDeckConfig",
      { deck: "Default" },
    ).then(async () => {
      // getDeckConfig returns config for a single deck. There is no plain
      // "list all configs" endpoint, but saveDeckConfig accepts a config
      // object and createDeckConfigId clones an existing one. Use the deck's
      // current config as a starting point.
      const cfg = await this.invoke<any>("getDeckConfig", { deck: deckName });
      return [cfg];
    }).catch(() => [] as Array<{ id: number; name: string }>);

    let cfg: any = allConfigs[0];
    if (!cfg || cfg.name !== AnkiService.OPTIONS_GROUP) {
      // Clone current config under a new name to avoid mutating Default
      const newId = await this.invoke<number>("cloneDeckConfigId", {
        name: AnkiService.OPTIONS_GROUP,
        cloneFrom: cfg?.id ?? 1,
      }).catch(() => null);
      if (newId) {
        cfg = await this.invoke<any>("getDeckConfig", { deck: deckName });
        cfg.id = newId;
        cfg.name = AnkiService.OPTIONS_GROUP;
        await this.invoke("setDeckConfigId", { decks: [deckName], configId: newId });
        cfg = await this.invoke<any>("getDeckConfig", { deck: deckName });
      }
    }
    if (!cfg) return; // can't configure; bail silently

    cfg.new = cfg.new ?? {};
    cfg.rev = cfg.rev ?? {};
    cfg.new.perDay = newPerDay;
    cfg.rev.perDay = revPerDay;
    cfg.name = AnkiService.OPTIONS_GROUP;
    await this.invoke("saveDeckConfig", { config: cfg });
  }
}
