import crypto from "node:crypto";
import { AnkiService } from "./anki";
import { textToSpeech } from "./azure";
import { generateBatch, generateExplanations, buildVocabPools } from "./sentenceGen";
import type { GeneratedSentence } from "@shared/types";

export interface PopulateOptions {
  vocabSourceDeck: string;
  bgbotDeckName: string;
  totalSentences: number;
  batchSize: number;
  newPerDay: number;
  revPerDay: number;
  onProgress?: (msg: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const buildAudioAttachment = async (
  sentence: GeneratedSentence,
  language: "en-GB" | "ur-PK",
  fieldName: "EnglishAudio" | "UrduAudio",
) => {
  const text = language === "ur-PK" ? sentence.urduArabic || sentence.urduRoman : sentence.english;
  if (!text) return null;
  try {
    const buf = await textToSpeech(text, language);
    const data = buf.toString("base64");
    const filename = `bgbot_${language}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.mp3`;
    return { data, filename, fields: [fieldName] };
  } catch (err) {
    console.warn(`TTS failed for ${language}:`, err);
    return null;
  }
};

export const commitBatch = async (
  anki: AnkiService,
  deckName: string,
  sentences: GeneratedSentence[],
): Promise<{ added: number; skipped: number }> => {
  const audiosPerSentence = await Promise.all(
    sentences.map(async (s) => {
      const [enAudio, urAudio] = await Promise.all([
        buildAudioAttachment(s, "en-GB", "EnglishAudio"),
        buildAudioAttachment(s, "ur-PK", "UrduAudio"),
      ]);
      return [enAudio, urAudio].filter((x): x is NonNullable<typeof x> => x !== null);
    }),
  );

  const notes = sentences.map((s, i) => ({
    deckName,
    modelName: AnkiService.MODEL_NAME,
    fields: {
      English: s.english,
      UrduArabic: s.urduArabic,
      UrduRoman: s.urduRoman,
      EnglishAudio: "",
      UrduAudio: "",
      Explanation: s.explanation ?? "",
    },
    tags: ["bgbot", "generated"],
    audio: audiosPerSentence[i].length > 0 ? audiosPerSentence[i] : undefined,
    options: { allowDuplicate: false },
  }));

  const ids = await anki.addNotes(notes);
  const added = ids.filter((x) => x !== null).length;
  return { added, skipped: ids.length - added };
};

export interface SeedOptions {
  bgbotDeckName: string;
  newPerDay: number;
  revPerDay: number;
  batchSize?: number;
  onProgress?: (msg: string) => void;
}

/**
 * Load the hand-written starter sentences into the deck. The LLM only writes
 * the brief per-card explanations; the sentences themselves are fixed.
 * Duplicates (from re-running) are skipped by Anki.
 */
export const seedDeck = async (
  sentences: GeneratedSentence[],
  opts: SeedOptions,
): Promise<{ added: number; skipped: number }> => {
  const log = opts.onProgress ?? ((m: string) => console.log(m));
  const batchSize = opts.batchSize ?? 10;
  const anki = new AnkiService();

  if (!(await anki.testConnection())) {
    throw new Error("Anki is not reachable. Open Anki desktop with the AnkiConnect plugin enabled.");
  }

  log(`Ensuring deck "${opts.bgbotDeckName}" and model exists…`);
  await anki.ensureModel();
  await anki.ensureDeckOptions(opts.bgbotDeckName, opts.newPerDay, opts.revPerDay);

  let totalAdded = 0;
  let totalSkipped = 0;
  const batchCount = Math.ceil(sentences.length / batchSize);
  for (let i = 0; i < batchCount; i++) {
    let batch = sentences.slice(i * batchSize, (i + 1) * batchSize);
    log(`Batch ${i + 1}/${batchCount}: synthesizing audio + adding ${batch.length} sentences…`);
    try {
      if (batch.some((s) => !s.explanation)) {
        try {
          batch = await generateExplanations(batch);
        } catch (err) {
          log(`  ! explanation generation failed, continuing without: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      const { added, skipped } = await commitBatch(anki, opts.bgbotDeckName, batch);
      totalAdded += added;
      totalSkipped += skipped;
      log(`  → added ${added}, skipped ${skipped} (duplicates).`);
    } catch (err) {
      log(`  ! batch ${i + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (i < batchCount - 1) await sleep(500);
  }

  log(`Done. Added ${totalAdded} cards (skipped ${totalSkipped} duplicates).`);
  return { added: totalAdded, skipped: totalSkipped };
};

/**
 * Populate (or top-up) the bgbot deck. Generates `totalSentences` in batches of
 * `batchSize` so the model never has to produce many at once.
 */
export const populate = async (opts: PopulateOptions): Promise<{ added: number; skipped: number }> => {
  const log = opts.onProgress ?? ((m: string) => console.log(m));
  const anki = new AnkiService();

  if (!(await anki.testConnection())) {
    throw new Error("Anki is not reachable. Open Anki desktop with the AnkiConnect plugin enabled.");
  }

  log(`Ensuring deck "${opts.bgbotDeckName}" and model exists…`);
  await anki.ensureModel();
  await anki.ensureDeckOptions(opts.bgbotDeckName, opts.newPerDay, opts.revPerDay);

  log(`Loading vocab pool from "${opts.vocabSourceDeck}"…`);
  const sourceNotes = await anki.getDeckNotes(opts.vocabSourceDeck);
  if (sourceNotes.length === 0) {
    throw new Error(`Source deck "${opts.vocabSourceDeck}" has no notes.`);
  }
  const pools = buildVocabPools(sourceNotes);
  log(`Vocab pool: ${pools.en.length} English, ${pools.ur.length} Urdu words.`);

  const batchCount = Math.ceil(opts.totalSentences / opts.batchSize);
  let totalAdded = 0;
  let totalSkipped = 0;
  for (let i = 0; i < batchCount; i++) {
    const want = Math.min(opts.batchSize, opts.totalSentences - i * opts.batchSize);
    log(`Batch ${i + 1}/${batchCount}: generating ${want} sentences…`);
    try {
      const sentences = await generateBatch(pools, want);
      log(`  → got ${sentences.length}; synthesizing audio + adding to Anki…`);
      const { added, skipped } = await commitBatch(anki, opts.bgbotDeckName, sentences);
      totalAdded += added;
      totalSkipped += skipped;
      log(`  → added ${added}, skipped ${skipped} (duplicates).`);
    } catch (err) {
      log(`  ! batch ${i + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (i < batchCount - 1) await sleep(500);
  }

  log(`Done. Added ${totalAdded} cards (skipped ${totalSkipped} duplicates).`);
  return { added: totalAdded, skipped: totalSkipped };
};
