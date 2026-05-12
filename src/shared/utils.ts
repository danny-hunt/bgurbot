import type { LanguageCode, VoiceName } from "./types";

export const otherLang = (language: LanguageCode): LanguageCode => {
  if (language === "ur-PK") return "en-GB";
  if (language === "en-GB") return "ur-PK";
  throw new Error(`Invalid language code: ${language}`);
};

export const langToVoiceName = (language: LanguageCode): VoiceName => {
  if (language === "ur-PK") return "ur-PK-UzmaNeural";
  if (language === "en-GB") return "en-GB-RyanNeural";
  throw new Error(`Invalid language code: ${language}`);
};
