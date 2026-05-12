import { makeOpenAICall, transliterateUrdu } from "./azure";
import type { GeneratedSentence } from "@shared/types";
import type { AnkiNoteInfo } from "./anki";

const safeParseJSON = <T = unknown>(text: string): T => {
  const trimmed = (text || "").trim();
  // Strip code fences if present, and grab the first JSON array we can find.
  const stripped = trimmed
    .replace(/^```(json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(stripped) as T;
  } catch {
    const start = stripped.indexOf("[");
    const end = stripped.lastIndexOf("]");
    if (start >= 0 && end > start) {
      return JSON.parse(stripped.slice(start, end + 1)) as T;
    }
    throw new Error("Failed to parse JSON from model output");
  }
};

const sample = <T,>(arr: T[], n: number): T[] => {
  if (arr.length <= n) return arr.slice();
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
};

/**
 * Build vocab pools from notes in the source deck. The Ling::Urdu deck uses
 * `worden` (English) and `word` (Urdu) field names; the urbot generator also
 * looked at `en`/`ur` as fallbacks.
 */
export const buildVocabPools = (notes: AnkiNoteInfo[]): { en: string[]; ur: string[] } => {
  const en: string[] = [];
  const ur: string[] = [];
  for (const note of notes) {
    const f = note.fields ?? {};
    const enWord = (f.worden?.value ?? f.en?.value ?? "").trim();
    const urWord = (f.word?.value ?? f.ur?.value ?? "").trim();
    if (enWord) en.push(enWord);
    if (urWord) ur.push(urWord);
  }
  return {
    en: Array.from(new Set(en.filter(Boolean))),
    ur: Array.from(new Set(ur.filter(Boolean))),
  };
};

/**
 * Generate one batch of N sentences. We sample a fresh subset of vocab on each
 * call so consecutive batches don't generate similar sentences.
 */
export const generateBatch = async (
  pools: { en: string[]; ur: string[] },
  count: number,
): Promise<GeneratedSentence[]> => {
  const vocabEn = sample(pools.en, 80);
  const vocabUr = sample(pools.ur, 80);

  const prompt = [
    "You are a tutor generating English sentences for a learner to translate into Urdu.",
    "Use primarily the provided vocabulary list. Common function words are allowed.",
    "Keep sentences conversational, everyday, and 6–14 words long.",
    "Avoid duplicating sentence structures across the batch — vary the verbs, tenses, and subjects.",
    `Generate exactly ${count} items as a strict JSON array. Each item: {"english": string, "urduArabic": string, "urduRoman": string}.`,
    "Do not include any commentary.",
    "Vocabulary (English focus; Urdu provided for your reference):",
    JSON.stringify({ vocabEn, vocabUr }),
  ].join("\n");

  const raw = await makeOpenAICall(prompt);
  const arr = safeParseJSON<Array<Partial<GeneratedSentence> & { urdu?: string }>>(raw);

  const out: GeneratedSentence[] = [];
  for (const item of arr) {
    const english = String(item.english ?? "").trim();
    const urduArabic = String(item.urduArabic ?? item.urdu ?? "").trim();
    let urduRoman = String(item.urduRoman ?? "").trim();
    if (!english) continue;
    if (!urduArabic && !urduRoman) continue;
    if (!urduRoman && urduArabic) {
      try {
        urduRoman = await transliterateUrdu(urduArabic);
      } catch {
        urduRoman = "";
      }
    }
    out.push({ english, urduArabic, urduRoman });
  }
  return out;
};
