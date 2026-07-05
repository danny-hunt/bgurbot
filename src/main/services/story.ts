/**
 * "The Serial" — a daily serialized Urdu micro-story. Every day one new
 * episode (8 sentences) is generated in a single LLM call, added to the bgbot
 * deck, and premiered by the loop in story order as the day's new cards.
 *
 * State is a small JSON file whose path is injected via initStoryStore()
 * (same pattern as costs.ts) so the module has no Electron dependency.
 */
import fs from "node:fs";
import path from "node:path";
import { AnkiService } from "./anki";
import { makeOpenAICall, transliterateUrdu } from "./azure";
import { buildVocabPools, safeParseJSON } from "./sentenceGen";
import { commitBatch } from "./populate";
import { getSettings } from "../settings";
import type { GeneratedSentence, StoryPublicState } from "@shared/types";

const EPISODE_SENTENCES = 8;
const VOCAB_SAMPLE = 60;

/** Tag applied to every note of episode N (on top of commitBatch's defaults). */
const episodeTag = (n: number): string => `bgbot::story::ep${n}`;

interface StoryState {
  premise: string;
  cast: string[];
  /** ~150-word learner-facing English summary, rewritten each episode. */
  storySoFar: string;
  /** Unresolved hooks the next episode can pick up. */
  threads: string[];
  episodeNumber: number;
  episodeTitle: string;
  /** Local YYYY-MM-DD of the last generated episode. */
  lastEpisodeDate: string;
  /** Previous episode verbatim, for the next prompt's continuity. */
  lastEpisodeSentences: GeneratedSentence[];
}

let state: StoryState | null = null;
let filePath: string | null = null;
/** Guards against overlapping generations (mirrors index.ts's topUpInFlight). */
let generationInFlight = false;

const dayKey = (d = new Date()): string => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const flush = (): void => {
  if (!filePath || !state) return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state));
  } catch (err) {
    console.warn("story store: save failed", err);
  }
};

export const initStoryStore = (file: string): void => {
  filePath = file;
  try {
    const loaded = JSON.parse(fs.readFileSync(file, "utf8")) as StoryState;
    if (typeof loaded.episodeNumber === "number") state = loaded;
  } catch {
    // No file yet — state is bootstrapped on first generation.
  }
  process.once("exit", flush);
};

/**
 * First-run premise and cast, built around the user's aboutMe. The two
 * invented side characters give the serial recurring comic texture beyond
 * the family.
 */
const bootstrapState = (aboutMe: string): StoryState => ({
  premise:
    '"The Serial" — a warm slice-of-life comedy-drama told in daily 8-sentence micro-episodes of simple Urdu. ' +
    `${aboutMe} ` +
    "The engine of the story: long-distance calls between Cumnor and Karachi, visits to Karachi, in-law " +
    "dynamics, running and bouldering mishaps, and the slowly-advancing plan to open a bouldering gym in Karachi.",
  cast: [
    "Danny — the protagonist, an English speaker in Cumnor, UK, learning Urdu",
    "Sarah — Danny's wife, in Karachi with her family",
    "Sarah's dad — head of the Karachi household",
    "Azim — Sarah's brother",
    "Shahzeen — Azim's wife",
    "Ibrahim and Amanah — Azim and Shahzeen's young kids",
    "Rafiq bhai — the chai-stall owner near Sarah's place, full of opinions about everything",
    "Tom — Danny's climbing buddy in Oxford, endlessly enthusiastic",
  ],
  storySoFar: "",
  threads: [],
  episodeNumber: 0,
  episodeTitle: "",
  lastEpisodeDate: "",
  lastEpisodeSentences: [],
});

const sample = <T,>(arr: T[], n: number): T[] => {
  if (arr.length <= n) return arr.slice();
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
};

interface EpisodeResponse {
  title?: string;
  sentences?: Array<Partial<GeneratedSentence>>;
  storySoFar?: string;
  threads?: string[];
}

/** safeParseJSON's fallback hunts for an array; episodes are objects. */
const parseEpisodeJSON = (raw: string): EpisodeResponse => {
  try {
    return safeParseJSON<EpisodeResponse>(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(raw.slice(start, end + 1)) as EpisodeResponse;
    }
    throw new Error("Failed to parse episode JSON from model output");
  }
};

const buildEpisodePrompt = (
  s: StoryState,
  aboutMe: string,
  vocab: { vocabEn: string[]; vocabUr: string[] },
): string => {
  const n = s.episodeNumber + 1;
  return [
    `You are writing episode ${n} of "The Serial" — a warm slice-of-life comedy-drama told in simple Urdu,`,
    "one short episode per day, for an English speaker learning Urdu (level A2/B1).",
    "",
    `PREMISE: ${s.premise}`,
    "",
    "CAST (recurring characters — keep them consistent):",
    ...s.cast.map((c) => `- ${c}`),
    "",
    `ABOUT THE LEARNER (ground details in this): ${aboutMe}`,
    "",
    s.storySoFar
      ? `STORY SO FAR: ${s.storySoFar}`
      : "STORY SO FAR: nothing yet — this is episode 1, so set the scene and introduce the world.",
    "",
    s.lastEpisodeSentences.length > 0
      ? `PREVIOUS EPISODE (${s.episodeNumber ? `episode ${s.episodeNumber}, ` : ""}verbatim, for continuity):\n` +
        JSON.stringify(s.lastEpisodeSentences.map((x) => ({ english: x.english, urduRoman: x.urduRoman })))
      : "PREVIOUS EPISODE: none.",
    "",
    s.threads.length > 0
      ? `UNRESOLVED THREADS (carry some forward; you may resolve, twist, or add): ${JSON.stringify(s.threads)}`
      : "UNRESOLVED THREADS: none yet — plant a couple.",
    "",
    "VOCABULARY to draw from where natural (common function words are always allowed):",
    JSON.stringify(vocab),
    "",
    `Write episode ${n}. Constraints:`,
    `- Exactly ${EPISODE_SENTENCES} sentences, in story order.`,
    "- Learner level A2/B1: simple conversational Urdu; each sentence 6–14 words.",
    "- Sentence 1 gently recaps where we left off; the last sentence ends on a MILD cliffhanger.",
    "- Warm and lightly funny; everyday stakes (calls, visits, in-laws, chai, running, bouldering, the gym plan) — no melodrama.",
    '- Vary structure; short dialogue is welcome (e.g. Sarah said, "…").',
    "",
    "Return ONLY a strict JSON object, no commentary:",
    '{"title": string (a short English episode title),',
    ` "sentences": [{"english": string, "urduArabic": string, "urduRoman": string, "explanation": string}, … exactly ${EPISODE_SENTENCES}],`,
    ' "storySoFar": string (rewrite the whole story-so-far from scratch: ~150 words of simple English, including this episode),',
    ' "threads": [string, …] (2–5 short unresolved hooks for future episodes)}',
    "Each explanation is ONE brief English sentence (under 20 words) for a learner: how the translation maps,",
    "flagging any grammar oddity (idiom, word order, gender agreement, ergative 'ne', literal meaning).",
  ].join("\n");
};

/** Clean and validate the model's sentences, transliterating missing romanizations. */
const normalizeSentences = async (
  items: Array<Partial<GeneratedSentence>>,
): Promise<GeneratedSentence[]> => {
  const out: GeneratedSentence[] = [];
  for (const item of items) {
    const english = String(item.english ?? "").trim();
    const urduArabic = String(item.urduArabic ?? "").trim();
    let urduRoman = String(item.urduRoman ?? "").trim();
    const explanation = String(item.explanation ?? "").trim();
    if (!english) continue;
    if (!urduArabic && !urduRoman) continue;
    if (!urduRoman && urduArabic) {
      try {
        urduRoman = await transliterateUrdu(urduArabic);
      } catch {
        urduRoman = "";
      }
    }
    out.push({ english, urduArabic, urduRoman, explanation });
  }
  return out;
};

/**
 * Generate today's episode if it doesn't exist yet, committing its sentences
 * to Anki tagged bgbot::story::ep<N>. Returns true only when a new episode
 * was generated by this call (index.ts uses this to skip the generic top-up);
 * false when the story is disabled, today's episode already exists, Anki is
 * unreachable, a generation is already in flight, or generation failed.
 */
export const ensureTodayEpisode = async (): Promise<boolean> => {
  const settings = getSettings();
  if (!settings.storyEnabled) return false;
  const today = dayKey();
  if (state && state.lastEpisodeDate === today) return false;
  if (generationInFlight) return false;
  generationInFlight = true;
  try {
    const anki = new AnkiService();
    if (!(await anki.testConnection())) return false;

    const s = state ?? bootstrapState(settings.aboutMe);

    // Fresh vocab sample so each episode leans on different source-deck words.
    const sourceNotes = await anki.getDeckNotes(settings.vocabSourceDeck).catch(() => []);
    const pools = buildVocabPools(sourceNotes);
    const vocab = {
      vocabEn: sample(pools.en, VOCAB_SAMPLE),
      vocabUr: sample(pools.ur, VOCAB_SAMPLE),
    };

    const n = s.episodeNumber + 1;
    console.log(`[story] generating episode ${n}…`);
    const raw = await makeOpenAICall(buildEpisodePrompt(s, settings.aboutMe, vocab), "medium");
    const parsed = parseEpisodeJSON(raw);
    const sentences = await normalizeSentences(
      Array.isArray(parsed.sentences) ? parsed.sentences : [],
    );
    // A thin episode isn't worth premiering — fail and let the fallback run.
    if (sentences.length < EPISODE_SENTENCES / 2) {
      throw new Error(`episode ${n}: only ${sentences.length} usable sentences`);
    }

    await anki.ensureModel();
    await anki.ensureDeckOptions(settings.bgbotDeckName, settings.newCardsPerDay, settings.reviewsPerDay);
    const { added, skipped } = await commitBatch(anki, settings.bgbotDeckName, sentences, [episodeTag(n)]);
    console.log(`[story] episode ${n} "${parsed.title ?? ""}": added ${added}, skipped ${skipped}`);

    // Persist even on a partial add — skipped duplicates are fine.
    state = {
      ...s,
      storySoFar: String(parsed.storySoFar ?? s.storySoFar).trim() || s.storySoFar,
      threads: Array.isArray(parsed.threads)
        ? parsed.threads.map((t) => String(t).trim()).filter(Boolean).slice(0, 6)
        : s.threads,
      episodeNumber: n,
      episodeTitle: String(parsed.title ?? "").trim() || `Episode ${n}`,
      lastEpisodeDate: today,
      lastEpisodeSentences: sentences,
    };
    flush();
    return true;
  } catch (err) {
    console.error("[story] episode generation failed:", err);
    return false;
  } finally {
    generationInFlight = false;
  }
};

/** True while an episode generation is running (started by any caller). */
export const storyGenerationInFlight = (): boolean => generationInFlight;

export const getPublicState = (): StoryPublicState | null => {
  if (!state || state.episodeNumber === 0) return null;
  return {
    episodeNumber: state.episodeNumber,
    episodeTitle: state.episodeTitle,
    storySoFar: state.storySoFar,
  };
};

/** Story-order (note-id ascending) ur->en card ids of the current episode. */
let premiereOrder: { episode: number; cardIds: number[] } | null = null;

/**
 * The ur->en cards (ord 1) of TODAY's episode that are still in Anki's new
 * queue, in story order. Empty when there's no episode premiering. Called
 * every loop iteration during the premiere: the story-order card list is
 * cached per episode, so each call costs one findCards round-trip (the
 * is:new check has to be fresh — answered cards leave the queue).
 */
export const getPremiereCardIds = async (anki: AnkiService): Promise<number[]> => {
  // Disabling the story mid-day drops the ordering; the episode's cards
  // simply fall back into the normal rotation.
  if (!getSettings().storyEnabled) return [];
  if (!state || state.episodeNumber === 0) return [];
  if (state.lastEpisodeDate !== dayKey()) return [];
  const episode = state.episodeNumber;

  const stillNew = new Set(await anki.findCards(`tag:${episodeTag(episode)} is:new`));
  if (stillNew.size === 0) return [];

  if (!premiereOrder || premiereOrder.episode !== episode) {
    const allIds = await anki.findCards(`tag:${episodeTag(episode)}`);
    const infos = await anki.getCardsInfo(allIds);
    const cardIds = infos
      .filter((c) => c.ord === 1)
      .sort((a, b) => a.note - b.note || a.cardId - b.cardId)
      .map((c) => c.cardId);
    premiereOrder = { episode, cardIds };
  }
  return premiereOrder.cardIds.filter((id) => stillNew.has(id));
};
