/**
 * Live scenario role-plays (idea 8): short (~6 learner turns) dialogues set in
 * situations from the user's real life. The app speaks the interlocutor's
 * line; the learner says a reply out loud, then taps which of the suggested
 * replies they used, and the next turn is generated live conditioned on it.
 * One scenario is active at a time, held in module state in main.
 */
import { ipcMain } from "electron";
import type {
  GeneratedSentence,
  ReplySuggestion,
  ScenarioContext,
  ScenarioTurnResult,
} from "@shared/types";
import { makeOpenAICall, transliterateUrdu } from "./azure";
import { safeParseJSON } from "./sentenceGen";
import { getSettings } from "../settings";
import { AnkiService } from "./anki";
import { commitBatch } from "./populate";
import { recordScenarioTurns } from "./stats";

/** Learner turns to aim for before the model wraps up on its own. */
const TARGET_TURNS = 6;
/** Learner turns after which the next line is forced to be the closing one. */
const HARD_STOP_TURNS = 8;

/**
 * Scenario settings drawn from the aboutMe world. The cast (Sarah, Azim,
 * Shahzeen, Ibrahim, Amanah) is hardcoded to match the current aboutMe text —
 * it's free text, so parsing names out of it isn't worth the fragility; the
 * full aboutMe is passed to the model per turn anyway, so generated dialogue
 * stays consistent even if the profile drifts from these vision lines.
 */
export const buildScenarioContexts = (): ScenarioContext[] => [
  {
    id: "inlaws-dinner",
    title: "Dinner with the in-laws",
    vision:
      "You're at the dinner table in Karachi; the haleem is incredible, and Sarah's dad wants to hear all about your day.",
  },
  {
    id: "video-call-sarah",
    title: "Video call with Sarah",
    vision:
      "It's evening in Cumnor; Sarah's face lights up the screen from Karachi, and tonight the whole call is in Urdu.",
  },
  {
    id: "chai-friends",
    title: "Chai with friends",
    vision:
      "You're squeezed around a dhaba table with Azim and his friends, chai steaming, and the banter is yours to keep up with.",
  },
  {
    id: "market",
    title: "At the market",
    vision:
      "You're picking up fruit at a Karachi market; the stallholder has already sized you up, but your Urdu is about to surprise him.",
  },
  {
    id: "taxi",
    title: "Taxi across Karachi",
    vision:
      "You flag a taxi to Sarah's family's place; the driver loves to talk, and for once you can talk right back.",
  },
  {
    id: "gym-planning",
    title: "Planning the bouldering gym",
    vision:
      "You and Sarah are sketching out the Karachi bouldering gym over chai — walls, mats, opening day — all in Urdu.",
  },
];

interface ActiveScenario {
  context: ScenarioContext;
  turns: Array<{ them: GeneratedSentence; learner?: ReplySuggestion }>;
  done: boolean;
}

let active: ActiveScenario | null = null;

const learnerTurnCount = (s: ActiveScenario): number =>
  s.turns.filter((t) => t.learner).length;

/** Shape the model is asked to return for one turn. */
interface RawTurn {
  them?: Partial<GeneratedSentence>;
  options?: Array<Partial<ReplySuggestion>>;
  done?: boolean;
}

/**
 * safeParseJSON's fallback only rescues JSON *arrays*; the turn payload is an
 * object, so add the equivalent first-{…last-} rescue for stray commentary.
 */
const parseTurnJSON = (raw: string): RawTurn => {
  try {
    return safeParseJSON<RawTurn>(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(raw.slice(start, end + 1)) as RawTurn;
    }
    throw new Error("Failed to parse scenario turn from model output");
  }
};

// The model occasionally puts the English translation in urduRoman instead of
// a transliteration; compare stripped of case/punctuation (same fix as
// suggest.ts) and repair via the transliteration API.
const normalize = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const fixRoman = async (line: GeneratedSentence): Promise<GeneratedSentence> => {
  const broken =
    Boolean(line.urduArabic) &&
    (!line.urduRoman || normalize(line.urduRoman) === normalize(line.english));
  if (!broken) return line;
  try {
    return { ...line, urduRoman: await transliterateUrdu(line.urduArabic) };
  } catch (err) {
    console.warn("scenario transliteration failed:", err);
    return line;
  }
};

const cleanLine = (item: Partial<GeneratedSentence> | undefined): GeneratedSentence => ({
  english: String(item?.english ?? "").trim(),
  urduArabic: String(item?.urduArabic ?? "").trim(),
  urduRoman: String(item?.urduRoman ?? "").trim(),
  ...(item?.explanation ? { explanation: String(item.explanation).trim() } : {}),
});

/** The dialogue so far, as the model sees it (chosen learner replies included). */
const transcriptFor = (s: ActiveScenario): Array<Record<string, string>> =>
  s.turns.flatMap((t) => {
    const lines: Array<Record<string, string>> = [
      { speaker: "them", urduArabic: t.them.urduArabic, english: t.them.english },
    ];
    if (t.learner) {
      lines.push({
        speaker: "learner",
        urduArabic: t.learner.urduArabic,
        english: t.learner.english,
      });
    }
    return lines;
  });

/** Generate the interlocutor's next line + reply options for the active scenario. */
const generateTurn = async (s: ActiveScenario): Promise<ScenarioTurnResult> => {
  const taken = learnerTurnCount(s);
  const mustClose = taken >= HARD_STOP_TURNS;
  const transcript = transcriptFor(s);

  const prompt = [
    "You are a tutor running a short live Urdu role-play with an English-speaking learner.",
    `Scenario: ${s.context.title}. ${s.context.vision}`,
    `About the learner: ${getSettings().aboutMe}`,
    'You play the other person ("them"); the learner replies in Urdu. Stay in character and keep the conversation natural and warm.',
    transcript.length === 0
      ? "The conversation has not started yet — them's line opens it."
      : "Dialogue so far (them = you, learner = the user):\n" + JSON.stringify(transcript),
    'Return a strict JSON object only: {"them": {"english": string, "urduArabic": string, "urduRoman": string, "explanation": string}, "options": [3 items of {"english": string, "urduArabic": string, "urduRoman": string}], "done": boolean}.',
    "them is the interlocutor's next natural line: simple, everyday, learner-level (A2/B1) Urdu, 4–14 words, responding to the learner's last reply.",
    "them.explanation is ONE brief English sentence (under 20 words) noting how the line maps or any grammar oddity. No preamble.",
    "options are exactly 3 replies the learner could say next: 4–10 words each, A2/B1, meaningfully different in intent (not paraphrases of each other).",
    "urduRoman is the Roman-script (Latin) transliteration of urduArabic — NOT the English translation.",
    `Set done to true when the conversation has naturally wrapped up — aim to close it politely by about ${TARGET_TURNS} learner turns (${taken} taken so far). When done, them is the closing line and options is [].`,
    mustClose
      ? "The conversation MUST end now: make them a warm closing line, set done to true, and return options as []."
      : "",
    "Do not include any commentary outside the JSON.",
  ]
    .filter(Boolean)
    .join("\n");

  // "minimal" effort keeps per-turn latency low (same tier as suggestions).
  const raw = await makeOpenAICall(prompt, "minimal");
  const parsed = parseTurnJSON(raw);

  const them = await fixRoman(cleanLine(parsed.them));
  if (!them.english || !(them.urduArabic || them.urduRoman)) {
    throw new Error("Model returned an empty scenario line");
  }

  const done = mustClose || Boolean(parsed.done);
  const options = done
    ? []
    : (
        await Promise.all(
          (parsed.options ?? [])
            .map(cleanLine)
            .filter((o) => o.english && (o.urduArabic || o.urduRoman))
            .slice(0, 3)
            .map(fixRoman),
        )
      ).map(({ explanation: _x, ...rest }) => rest);

  s.turns.push({ them });
  s.done = done;
  return { them, options, done, turnCount: learnerTurnCount(s) };
};

/** End the active scenario, crediting the learner's turns to today's stats. */
const endScenario = (): { turns: number } => {
  const turns = active ? learnerTurnCount(active) : 0;
  recordScenarioTurns(turns);
  active = null;
  return { turns };
};

/** Register the scenario:* IPC handlers. Called once from main's setup. */
export const registerScenarioIpc = (): void => {
  ipcMain.handle("scenario:contexts", () => buildScenarioContexts());

  ipcMain.handle("scenario:start", async (_e, contextId: string) => {
    const context = buildScenarioContexts().find((c) => c.id === contextId);
    if (!context) throw new Error(`Unknown scenario "${contextId}"`);
    // Starting over an active scenario abandons it (its turns still count).
    if (active) endScenario();
    const started: ActiveScenario = { context, turns: [], done: false };
    active = started;
    try {
      return await generateTurn(started);
    } catch (err) {
      // Don't leave a scenario with no opening line lying around.
      if (active === started) active = null;
      throw err;
    }
  });

  ipcMain.handle("scenario:reply", async (_e, reply: ReplySuggestion) => {
    const current = active;
    if (!current) throw new Error("No active scenario — start one first.");
    if (current.done) throw new Error("The scenario has already wrapped up.");
    const last = current.turns[current.turns.length - 1];
    if (!last || last.learner) throw new Error("Not waiting for a reply right now.");
    last.learner = reply;
    const result = await generateTurn(current);
    // A concurrent start/end may have replaced the scenario mid-generation;
    // the stale result is still fine to show, but don't resurrect state.
    return result;
  });

  ipcMain.handle("scenario:end", () => endScenario());

  ipcMain.handle("scenario:save", async (_e, line: GeneratedSentence) => {
    await commitBatch(new AnkiService(), getSettings().bgbotDeckName, [line]);
    return { ok: true };
  });
};
