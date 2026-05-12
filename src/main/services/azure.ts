import {
  AudioConfig,
  SpeechConfig,
  SpeechSynthesizer,
  PullAudioOutputStream,
} from "microsoft-cognitiveservices-speech-sdk";
import { AzureOpenAI } from "openai";
import type { LanguageCode } from "@shared/types";
import { langToVoiceName } from "@shared/utils";

const TextTranslationClient = require("@azure-rest/ai-translation-text").default;

const azureSpeechRegion = "uksouth";

let _openai: AzureOpenAI | null = null;
const openai = (): AzureOpenAI => {
  if (_openai) return _openai;
  _openai = new AzureOpenAI({
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    apiKey: process.env.AZURE_OPENAI_API_KEY,
    apiVersion: "2025-01-01-preview",
    deployment: "gpt-5-nano",
  });
  return _openai;
};

let _translit: any = null;
const translit = (): any => {
  if (_translit) return _translit;
  _translit = new TextTranslationClient(
    "https://api.cognitive.microsofttranslator.com",
    {
      key: process.env.AZURE_TRANSLATOR_KEY,
      region: "uksouth",
    },
  );
  return _translit;
};

export const makeOpenAICall = async (text: string): Promise<string> => {
  if (!process.env.AZURE_OPENAI_API_KEY) {
    throw new Error("AZURE_OPENAI_API_KEY missing");
  }
  const result = await openai().chat.completions.create({
    messages: [
      { role: "developer", content: "You are an AI assistant that helps people find information." },
      { role: "user", content: text },
    ],
    max_completion_tokens: 16384,
    model: "gpt-5-nano",
  });
  return result.choices[0]?.message?.content ?? "";
};

/**
 * Synthesize speech to a buffer (mp3). Uses a pull stream so audio bytes are
 * returned to the main process; playback happens in the hidden audio renderer.
 */
export const textToSpeech = async (
  text: string,
  language: LanguageCode,
): Promise<Buffer> => {
  const key = process.env.AZURE_SPEECH_KEY ?? "";
  if (!key) throw new Error("AZURE_SPEECH_KEY missing");
  const speechConfig = SpeechConfig.fromSubscription(key, azureSpeechRegion);
  speechConfig.speechSynthesisLanguage = language;
  speechConfig.speechSynthesisVoiceName = langToVoiceName(language);

  // Use null AudioConfig so audio is returned in result.audioData rather than
  // played to a (non-existent) default device on the main process.
  const synthesizer = new SpeechSynthesizer(speechConfig, undefined as unknown as AudioConfig);
  return new Promise<Buffer>((resolve, reject) => {
    synthesizer.speakTextAsync(
      text,
      (result) => {
        try {
          if (result.errorDetails) {
            reject(new Error(result.errorDetails));
            return;
          }
          resolve(Buffer.from(result.audioData));
        } finally {
          synthesizer.close();
        }
      },
      (error) => {
        reject(error instanceof Error ? error : new Error(String(error)));
        synthesizer.close();
      },
    );
  });
};

export const transliterateUrdu = async (text: string): Promise<string> => {
  const response = await translit().path("/transliterate").post({
    body: [{ text }],
    queryParameters: { language: "ur", toScript: "Latn", fromScript: "Arab" },
  });
  const out = response.body[0]?.text;
  if (!out) throw new Error("Transliteration failed");
  return out;
};
