import { makeOpenAICall, transliterateUrdu } from "./azure";
import { safeParseJSON } from "./sentenceGen";
import type { TranslationLookup } from "@shared/types";

const CACHE_MAX = 200;
const cache = new Map<string, TranslationLookup>();
const inFlight = new Map<string, Promise<TranslationLookup>>();

const hasArabicScript = (text: string): boolean => /[؀-ۿ]/.test(text);

/** Parse the model's JSON object, tolerating fences/commentary around it. */
const parseLookup = (raw: string): { detected: "ur" | "en"; translation: string } => {
  let obj: unknown;
  try {
    obj = safeParseJSON(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("Failed to parse translation from model output");
    obj = JSON.parse(raw.slice(start, end + 1));
  }
  if (Array.isArray(obj)) obj = obj[0];
  const item = (obj ?? {}) as Partial<{ detected: string; translation: string }>;
  const detected = item.detected === "ur" ? "ur" : "en";
  const translation = String(item.translation ?? "").trim();
  if (!translation) throw new Error("Model returned no translation");
  return { detected, translation };
};

const fetchLookup = async (input: string): Promise<TranslationLookup> => {
  const prompt = [
    "You are an Urdu <-> English translator helping an English speaker learn Urdu.",
    "Detect the language of the input text below: Urdu (Arabic script or Roman transliteration) or English.",
    "If the input is Urdu, translate it into natural English.",
    "If the input is English, translate it into natural, everyday Urdu written in Arabic script.",
    'Answer with a strict JSON object only: {"detected": "ur" | "en", "translation": string}.',
    "Do not include any commentary.",
    "Input text:",
    input,
  ].join("\n");

  const raw = await makeOpenAICall(prompt, "minimal");
  const { detected, translation } = parseLookup(raw);
  const result: TranslationLookup = { input, detected, translation };

  // Latin-script transliteration of whichever side is Urdu — best-effort only.
  try {
    if (detected === "ur" && hasArabicScript(input)) {
      result.inputTranslit = await transliterateUrdu(input);
    } else if (detected === "en" && hasArabicScript(translation)) {
      result.translationTranslit = await transliterateUrdu(translation);
    }
  } catch (err) {
    console.warn("lookup transliteration failed:", err);
  }
  return result;
};

/**
 * Ad-hoc Urdu↔English lookup for the player's translate box.
 * Cached per normalized input; LLM failures reject so the renderer can show an error.
 */
export const lookupTranslation = async (text: string): Promise<TranslationLookup> => {
  const input = (text ?? "").trim().replace(/\s+/g, " ");
  if (!input) throw new Error("Nothing to translate");
  const key = input.toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;
  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = fetchLookup(input)
    .then((result) => {
      cache.set(key, result);
      // FIFO eviction — Map preserves insertion order
      while (cache.size > CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      return result;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
};
