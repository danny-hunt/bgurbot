# bgurbot

**bgurbot** is a macOS app for hands-free Urdu practice. It continuously plays spaced-repetition sentence cards from Anki: it speaks a sentence in one language, pauses so you can translate it in your head, then speaks the translation. You rate your recall with global hotkeys (or on-screen buttons) without ever switching apps. A small vertical **player window** mirrors the loop — showing the sentence, revealing the translation when the answer plays, and suggesting replies you could say in response — while a menu-bar (tray) item and global hotkeys keep it usable in the background; closing the window never stops the loop.

It is built with **Electron** (electron-vite, TypeScript, React for the settings UI) and integrates three external services:

| Service | Purpose |
|---|---|
| **Anki + AnkiConnect** (`http://127.0.0.1:8765`) | Card storage, scheduling, ratings, media |
| **Azure Speech** (uksouth) | Neural text-to-speech for English (`en-GB`) and Urdu (`ur-PK`) |
| **Azure OpenAI** (`gpt-5-nano`) + **Azure Translator** | Generating new practice sentences and Roman-Urdu transliteration |

## What it does

### 1. Background listening loop (`src/main/loop.ts`)

The core of the app is an infinite loop that, while running:

1. Checks Anki is reachable (backs off and retries if not).
2. Fetches the next playable card from the `bgbot` deck — review-due cards first, then new cards up to the configured daily cap.
3. Determines direction from the card template: ord 0 is **English → Urdu**, ord 1 is **Urdu → English** (every note produces both cards).
4. Plays the **source** audio, waits a configurable pause (`pauseSeconds`, default 10 s) for you to mentally translate, then plays the **translation** audio, then waits (indefinitely) for you to rate the card before moving on. Rating at **any** point — even mid-audio or during the think-pause — ends the card immediately and moves on; skip does the same without a rating.
5. Submits your rating to Anki's scheduler (`answerCards`). If you skipped without rating, it defaults to **Again**, so the card stays in rotation.

Audio comes from the card's stored `[sound:...]` media file when present, with on-the-fly Azure TTS as a fallback. Playback happens in a hidden 1×1 renderer window (`src/main/audio.ts` + `src/renderer/audio/`) because the Electron main process has no audio device; MP3 buffers are shipped over IPC and played with an HTML `Audio` element.

With **auto-advance off**, the loop stops after each card and waits for the skip hotkey before continuing — unless you rated the card explicitly, in which case it advances straight to the next one.

### 2. Automatic deck top-up (sentence generation)

When the loop finds no due/new cards, it triggers a **top-up**: 10 new sentences are generated and added to Anki (`src/main/services/populate.ts`, `sentenceGen.ts`):

- Vocabulary is harvested from a source deck (default `Ling::Urdu`, reading `worden`/`word` or `en`/`ur` fields) into English/Urdu word pools.
- A random sample of ~80 words is sent to Azure OpenAI with a prompt asking for conversational 6–14-word sentences as strict JSON (`english`, `urduArabic`, `urduRoman`).
- Missing Roman Urdu is filled in via Azure Translator transliteration (Arabic → Latin script).
- Both English and Urdu audio are synthesized with Azure TTS and attached to the note.
- Notes are added to the `bgbot` deck using a custom **BgbotSentence** model (fields: English, UrduArabic, UrduRoman, EnglishAudio, UrduAudio; two card templates for the two directions), tagged `bgbot generated`, with duplicates skipped.

The model and a dedicated `bgbot` deck-options group (new/day and reviews/day caps) are created idempotently on startup and before each populate run.

Top-ups can also be run manually from the tray menu, the settings window, or the CLI:

```sh
npm run populate -- --total 200 --batch 10 --source "Ling::Urdu" --deck bgbot
```

### 3. Player window (`src/renderer/player/`)

A small vertical window (opened on launch; reopen via the dock icon or tray) that mirrors the loop in real time:

- **Current card** — direction badge, source sentence (Urdu rendered right-to-left with Roman transliteration), and the translation hidden until the answer audio plays; tap to reveal early (which also cuts the think-pause short).
- **Think-pause countdown** — a progress bar shows how long you have left to translate in your head.
- **Controls** — pause/resume, replay question, replay answer, skip; plus Again/Hard/Good/Easy rating buttons (Anki colours).
- **Reply suggestions** — once the answer is revealed, 2–3 natural Urdu replies you could say in response (Arabic + Roman + English gloss, generated via Azure OpenAI, cached per note, toggleable in settings) with tap-to-hear TTS. Generation is kicked off as soon as the card starts so the suggestions are ready by reveal time, but they are never shown before the answer.
- **Session history** — recent cards with the rating you gave; tap to expand and replay either side's audio.

### 4. Menu-bar UI and global hotkeys (`src/main/index.ts`)

- **Tray item** (shows "bg" in the menu bar) with a live status line — loop state, due count, new-cards-today, "generating…" — and menu actions: Pause/Resume, Skip, Replay source, Generate top-up now, Open player window, Open settings, Quit.
- **Global hotkeys** (configurable, work system-wide): rate Again/Hard/Good/Easy, pause/resume, skip, replay the source sentence, and replay the translation.
- The app stays alive when all windows close — the loop keeps playing in the background.

### 5. Settings window (`src/renderer/settings/`)

A React window (opened from the tray) for editing persisted settings (`electron-store`, see `src/main/settings.ts` / `src/shared/types.ts`):

- Timing: pause before translation, gap between cards, auto-advance toggle.
- Decks: vocab source deck and bgbot deck names; new-cards-per-day and reviews-per-day caps.
- Player: reply-suggestions toggle.
- Hotkey bindings (failures to register are reported back to the UI).
- **API cost tracking**: every Azure call is metered (TTS characters, OpenAI tokens, Translator characters) and shown as estimated spend — today / this month / all time — with a reset button. Counters persist in `costs.json` next to the settings file (`src/main/services/costs.ts`); the populate CLI writes to the same file, so bulk generation is counted too. Figures are usage × list price, so free-tier allowances are not reflected.
- Utilities exposed over IPC: test the Anki connection, list decks, show due count, run a populate with a chosen count, and control the loop (pause/resume/skip/replay). Live status updates are pushed to the window.

## Configuration

Secrets go in a `.env` file (see `.env.example`):

```
AZURE_SPEECH_KEY=       # Azure Speech (TTS), region uksouth
AZURE_TRANSLATOR_KEY=   # Azure Translator (transliteration), region uksouth
AZURE_OPENAI_ENDPOINT=  # Azure OpenAI endpoint
AZURE_OPENAI_API_KEY=   # Azure OpenAI key (gpt-5-nano deployment)
```

Anki desktop must be running with the AnkiConnect add-on on the default port.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Run the app in development (electron-vite) |
| `npm run build` | Build to `out/` |
| `npm run start` | Preview the built app |
| `npm run populate` | Build, then bulk-generate cards from the CLI |

## Source layout

```
src/
├── main/                 # Electron main process
│   ├── index.ts          # App entry: tray, hotkeys, IPC, startup bootstrap
│   ├── loop.ts           # The play → pause → translate → rate loop
│   ├── audio.ts          # Hidden-window audio playback bridge
│   ├── settings.ts       # Persisted settings (electron-store)
│   └── services/
│       ├── anki.ts       # AnkiConnect client (decks, cards, model, ratings)
│       ├── azure.ts      # Azure TTS, OpenAI chat, transliteration
│       ├── sentenceGen.ts# Vocab pools + LLM sentence generation
│       ├── suggest.ts    # LLM reply suggestions (cached per note)
│       ├── costs.ts      # API usage metering + estimated spend

│       └── populate.ts   # Batch generate + synthesize + add to Anki
├── preload/              # Context-isolated IPC bridges
├── renderer/
│   ├── audio/            # Hidden playback page
│   ├── player/           # React player window (card, controls, suggestions)
│   └── settings/         # React settings window
├── scripts/populate.ts   # CLI entry for bulk population
└── shared/               # Types, defaults, voice mapping
```
