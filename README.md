# voice-translator

**Meet AI Interpreter** is a real-time, two-way speech-to-speech interpreter Chrome extension (Manifest V3) for Google Meet, powered by a Node.js/TypeScript backend.

- **Outgoing:** Speak in natural Bangla; Google Meet participants hear Tokyo business Japanese (`丁寧語 / です・ます調`) or English streamed directly into the meeting microphone in real time (`gpt-realtime-translate`).
- **Incoming:** Clients speak in either Japanese or English; the system auto-detects their language on the fly (`gpt-realtime-whisper`), translates into natural Bangladeshi IT Bengali (`gpt-4.1-mini`), and plays the voice directly into your headphones with Edge-TTS (`bn-BD-NabanitaNeural`).
- **Meeting HUD & Assistance:** Shows live transcripts, translations, and actionable reply bullet points directly inside Google Meet.

---

## Architecture Overview

```
Google Meet Tab (meet.google.com)
  ├── inject.js   (MAIN world: intercepts virtual mic, remote audio bus, playback)
  ├── bridge.js   (ISOLATED world: HUD panel, settings, state management)
  └── captions.js (Optional fallback watcher for Google Meet CC)
         │
         │ (chrome.runtime port / messages)
         ▼
Chrome Service Worker (background.js)
         │
         │ (HTTP REST / WebSockets: /ws/translate & /ws/transcribe)
         ▼
Node.js / Express Backend (backend/)
  ├── Outgoing: OpenAI Realtime Speech-to-Speech (gpt-realtime-translate)
  ├── Incoming: OpenAI Realtime Transcription (gpt-realtime-whisper)
  ├── Fast LLM Translation & Context Analysis (gpt-4.1-mini)
  └── Multi-provider TTS (Edge-TTS, OpenAI TTS, Google Translate fallback)
```

---

## Getting Started

### 1. Backend Setup

```bash
cd backend
npm install
cp .env.example .env
# Configure your OPENAI_API_KEY in .env
npm run dev
```

Verify backend health:
```bash
curl http://localhost:3000/health
```

### 2. Chrome Extension Setup

1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Toggle on **Developer mode** in the top right.
3. Click **Load unpacked** and select the `extension/` directory.
4. Open or join a meeting on `https://meet.google.com/`.
5. The **AI Interpreter** panel will appear at the bottom-right corner.

---

## Shortcuts

- `Alt + C` : Start / Stop conversation (Both Ways: Outgoing + Incoming)
- `Alt + B` : Start / Stop outgoing Bangla translation
- `Alt + L` : Start / Stop incoming client translation

---

## Documentation

For full architecture details, message protocols, and configuration options, see [PROJECT_DOCUMENTATION.md](PROJECT_DOCUMENTATION.md).
