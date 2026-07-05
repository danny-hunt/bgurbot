import { makeOpenAICall, transliterateUrdu } from "./azure";
import { safeParseJSON } from "./sentenceGen";
import { AnkiService } from "./anki";
import type { CardSnapshot, ReplySuggestion } from "@shared/types";

// Suggestions are generated at most once per note, ever: results are written
// back to the note's Suggestions field in Anki (as JSON) and arrive with the
// card snapshot on later encounters. The in-memory cache just avoids repeat
// work within a session.
const cache = new Map<number, ReplySuggestion[]>();
const inFlight = new Map<number, Promise<ReplySuggestion[]>>();
const anki = new AnkiService();

/** Parse the Suggestions note field (JSON written by us). Bad data → null. */
export const parseStoredSuggestions = (fieldValue: string): ReplySuggestion[] | null => {
  const raw = fieldValue.trim();
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw) as Array<Partial<ReplySuggestion>>;
    if (!Array.isArray(arr) || arr.length === 0) return null;
    return arr.map((item) => ({
      english: String(item.english ?? "").trim(),
      urduArabic: String(item.urduArabic ?? "").trim(),
      urduRoman: String(item.urduRoman ?? "").trim(),
    }));
  } catch {
    return null;
  }
};

// The model occasionally puts the English translation in urduRoman instead of
// a transliteration (and older notes have this persisted). Compare stripped of
// case/punctuation so "Sure, how can I help?" matches "sure how can i help".
const normalize = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const romanIsBroken = (s: ReplySuggestion): boolean =>
  Boolean(s.urduArabic) && (!s.urduRoman || normalize(s.urduRoman) === normalize(s.english));

/** Fill in missing/English-polluted urduRoman via transliteration. */
const repairRomanizations = async (
  suggestions: ReplySuggestion[],
): Promise<{ suggestions: ReplySuggestion[]; changed: boolean }> => {
  let changed = false;
  const repaired = await Promise.all(
    suggestions.map(async (s) => {
      if (!romanIsBroken(s)) return s;
      try {
        const urduRoman = await transliterateUrdu(s.urduArabic);
        changed = true;
        return { ...s, urduRoman };
      } catch (err) {
        console.warn("suggestion transliteration failed:", err);
        return s;
      }
    }),
  );
  return { suggestions: repaired, changed };
};

const fetchSuggestions = async (snapshot: CardSnapshot): Promise<ReplySuggestion[]> => {
  const prompt = [
    "You are a tutor helping an English speaker practice conversational Urdu.",
    "Given the sentence below, suggest 3 natural, short replies the learner could say in response.",
    "Keep replies simple, everyday, learner-level (A2/B1), and 4–10 words each.",
    'Answer with a strict JSON array only. Each item: {"english": string, "urduArabic": string, "urduRoman": string}.',
    "urduRoman is the Roman-script (Latin) transliteration of urduArabic — NOT the English translation.",
    "Do not include any commentary.",
    "Sentence:",
    JSON.stringify({
      english: snapshot.english,
      urduArabic: snapshot.urduArabic,
      urduRoman: snapshot.urduRoman,
    }),
  ].join("\n");

  const raw = await makeOpenAICall(prompt, "minimal");
  const arr = safeParseJSON<Array<Partial<ReplySuggestion>>>(raw);
  return arr
    .map((item) => ({
      english: String(item.english ?? "").trim(),
      urduArabic: String(item.urduArabic ?? "").trim(),
      urduRoman: String(item.urduRoman ?? "").trim(),
    }))
    .filter((s) => s.english && (s.urduArabic || s.urduRoman))
    .slice(0, 3);
};

/**
 * Replies the learner could say in response to the card's sentence.
 * Generated once per note and stored on the note itself; failures resolve to
 * [] so callers can just hide the panel.
 */
export const getReplySuggestions = async (snapshot: CardSnapshot): Promise<ReplySuggestion[]> => {
  const cached = cache.get(snapshot.noteId);
  if (cached) return cached;
  const pending = inFlight.get(snapshot.noteId);
  if (pending) return pending;

  const stored = snapshot.suggestions;
  // Stored suggestions may carry a broken urduRoman from before the prompt
  // fix; repair lazily and only re-save when something actually changed.
  const source: Promise<{ suggestions: ReplySuggestion[]; changed: boolean }> =
    stored && stored.length > 0
      ? repairRomanizations(stored)
      : fetchSuggestions(snapshot).then(async (fresh) => ({
          ...(await repairRomanizations(fresh)),
          changed: fresh.length > 0, // fresh results always need saving
        }));

  const promise = source
    .then(async ({ suggestions, changed }) => {
      cache.set(snapshot.noteId, suggestions);
      if (changed) {
        // Persist onto the note; if Anki rejects (e.g. note open in the
        // editor) the session cache still serves it and we retry next time.
        await anki
          .updateNoteFields(snapshot.noteId, { Suggestions: JSON.stringify(suggestions) })
          .catch((err) => console.warn("saving suggestions to note failed:", err));
      }
      return suggestions;
    })
    .catch((err) => {
      console.warn("suggestions failed:", err);
      return [] as ReplySuggestion[];
    })
    .finally(() => {
      inFlight.delete(snapshot.noteId);
    });
  inFlight.set(snapshot.noteId, promise);
  return promise;
};
