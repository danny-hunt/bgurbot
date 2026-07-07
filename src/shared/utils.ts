import type { LanguageCode, VoiceName } from "./types";

export const otherLang = (language: LanguageCode): LanguageCode => {
  if (language === "ur-PK") return "en-GB";
  if (language === "en-GB") return "ur-PK";
  throw new Error(`Invalid language code: ${language}`);
};

/** Local YYYY-MM-DD — the key used for all per-day state. */
export const localDayKey = (d = new Date()): string => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export const langToVoiceName = (language: LanguageCode): VoiceName => {
  if (language === "ur-PK") return "ur-PK-UzmaNeural";
  if (language === "en-GB") return "en-GB-RyanNeural";
  throw new Error(`Invalid language code: ${language}`);
};
