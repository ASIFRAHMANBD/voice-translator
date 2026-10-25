# Plan: Voice Dropdown (Male / Female) for Translated Speech

**Status: implemented.** All steps below are done and verified. See "What was verified" at the end.

## Goal

Add a **dropdown in the extension** that lets the user pick a male or female voice for the
translated speech. The dropdown sits in the HUD panel **above the Hands-free / Push-to-talk
mode switch**, so it is reachable without opening Settings.

The choice applies to both directions (your Bangla voice and the client's Japanese/English voice),
and it persists for the whole conversation — it is stored once and every later request uses it.

### The dropdown

| Option value | Label | Effect |
| --- | --- | --- |
| `default` | Default | Provider's own configured voice (current behaviour, unchanged) |
| `male` | Male | Male voice for the target language |
| `female` | Female | Female voice for the target language |

Rendered as a `<select>` with id `mai-voice`, in a `.mai-voice-picker` wrapper placed directly
above the mode switch in the HUD body.

## How the voice was picked before

- Backend picked the voice from env config only: `backend/src/config.ts` held
  `edge.voices = { bn, ja, en }` — one fixed Edge voice per language.
- `backend/src/adapters/tts/edgeTts.ts` read that map. Every synthesis used the same voice.
- The extension already had a working "Voice speed" picker that threads `voiceRate` from
  `chrome.storage.local` -> bridge payload -> background fetch -> backend -> `TtsOptions`.
  The voice feature follows that exact pattern, so the plumbing was proven.

## Design decision: send a gender, not a raw voice id

The extension sends `voice` = `"male"` | `"female"` (not a provider-specific voice id).
The backend maps gender + language to a concrete provider voice.

Why:
- The extension stays provider-agnostic. It never learns Edge voice ids, ElevenLabs voice ids
  or OpenAI voice names.
- Each provider can map the same gender to its own voice (`edge` -> `bn-BD-PradeepNeural`,
  `openai` -> `onyx`/`coral`, `elevenlabs` -> configured male/female ids).
- `TtsOptions` grows one small field; every adapter already receives `options`.

Value `"default"` means "keep the provider's configured voice" (no change of behaviour).

## Data flow (single request path)

```
HUD dropdown (mai-voice: default | male | female)
  -> chrome.storage.local "voice"
     -> bridge state.voice
        -> clip payload { voice }            (PROCESS_VOICE)
        -> SYNTHESIZE payload { voice }      (remaining sentences)
           -> background.js -> form field "voice" / JSON body "voice"
              -> routes/processVoice.ts + routes/speech.ts parse it
                 -> ProcessVoiceRequest.voice / synthesizeSpeech(..., voice)
                    -> adapters.tts.synthesize(text, lang, { rate, voice })
                       -> provider-specific voice id
                          (male -> bn-BD-PradeepNeural, female -> bn-BD-NabanitaNeural, ...)
```

Playback needs no change: `extension/inject.js` only decodes MP3 and plays it.
The voice is decided entirely upstream, so the dropdown alone controls the sound.

## Changes

### 1. Backend types — `backend/src/types.ts`

- `Voice` type added (line 5): `"male" | "female" | "default"`.
- `TtsOptions` (line 28): `voice?: Voice`.
- `ProcessVoiceRequest` (line 62): `voice: Voice`.
- `TtsAdapter` (lines 42-49): added `supportsGender?: boolean`. A provider that has no
  voice parameter sets it to `false`, so it can never be used as a fallback for a request
  that asks for a gender. See "The gender-blind fallback" below.

### 2. Backend config — `backend/src/config.ts`

`edge.voices` became a gender map per language:

```ts
edge: {
  voices: {
    bn: { male: readString("EDGE_TTS_VOICE_BN_MALE", "bn-BD-PradeepNeural"),
          female: readString("EDGE_TTS_VOICE_BN_FEMALE", "bn-BD-NabanitaNeural") },
    ja: { male: readString("EDGE_TTS_VOICE_JA_MALE", "ja-JP-KeitaNeural"),
          female: readString("EDGE_TTS_VOICE_JA_FEMALE", "ja-JP-NanamiNeural") },
    en: { male: readString("EDGE_TTS_VOICE_EN_MALE", "en-US-AndrewMultilingualNeural"),
          female: readString("EDGE_TTS_VOICE_EN_FEMALE", "en-US-AvaMultilingualNeural") },
  } as Record<string, Record<string, string>>,
}
```

Also added `openai.ttsVoices: { male, female }` (env `OPENAI_TTS_VOICE_MALE` /
`OPENAI_TTS_VOICE_FEMALE`, defaults `onyx` / `coral`) and `elevenlabs.voiceIds: { male, female }`
(env `ELEVENLABS_VOICE_ID_MALE` / `ELEVENLABS_VOICE_ID_FEMALE`, defaulting to the existing
`ELEVENLABS_VOICE_ID` for both so nothing breaks).

The old single-voice env vars (`EDGE_TTS_VOICE_BN` etc.) were replaced outright rather than kept
as aliases — the extension is the only caller and it always sends a gender.

### 3. Backend validation — `backend/src/lib/validation.ts`

Added `parseVoice(raw): Voice` (lines 15-18) next to `parseVoiceRate`:

```ts
export const parseVoice = (raw: unknown): Voice => {
  const value = String(raw ?? "").trim().toLowerCase()
  return value === "male" || value === "female" ? value : "default"
}
```

Invalid values fall back to `"default"`. Same clamping style as `parseVoiceRate`.

### 4. Backend adapters

| File | Change |
| --- | --- |
| `adapters/tts/edgeTts.ts:83-96` | `pickVoice(lang, voice)` looks up `config.edge.voices[lang][gender]`; `"default"` falls back to `female` then `male`. The existing per-voice websocket cache (`connections`/`queues`, lines 39-40) already handles two different voices — no cache change needed. `supportsGender: true`. |
| `adapters/tts/openai.ts` | `pickVoice(voice)` maps the gender to `config.openai.ttsVoices.male` / `.female`, `"default"` to `config.openai.ttsVoice`. `buildInstructions(voice)` appends an explicit gender instruction (see "The Female voice sounded like Male" below). `supportsGender: true`. |
| `adapters/tts/elevenlabs.ts:10-21` | The voice id is baked into the URL, so it is now chosen per request inside `synthesize` via `pickVoiceId(voice)`. `supportsGender: true`. |
| `adapters/tts/customHttp.ts:19` | `voice` added to the JSON body: `{ text, lang, rate, voice }`. Contract comment updated. `supportsGender: true`. |
| `adapters/tts/googleTranslate.ts:30-33` | The endpoint takes no voice parameter, so `supportsGender: false`. It must never be used as a fallback for a gender request. |

`adapters/tts/index.ts` needed a real change: `withFallback` was replaced by `withChain`
(see "The gender-blind fallback" below).

### 5. Backend routes / service

- `routes/processVoice.ts:91` — `voice: parseVoice(req.body?.voice)`.
  `multer` is configured with `fields: 9` (line 19); adding a 9th form field needed
  `fields: 9`. The 9 fields are: `audio`, `text`, `lang`, `direction`, `target_lang`,
  `tts`, `voice_rate`, `context`, `voice`.
- `routes/speech.ts:61` — `synthesizeSpeech(text, lang, parseVoiceRate(...), parseVoice(req.body?.voice))`.
- `services/aiService.ts:119` — passes `voice: request.voice` into `adapters.tts.synthesize`.
- `services/aiService.ts:153-156` — `synthesizeSpeech` takes the extra `voice` argument.

### 6. Extension service worker — `extension/background.js`

- `VOICES` set (line 13): `new Set(["male", "female", "default"])`.
- `isValidVoice` (line 31) used by `validateVoicePayload` (line 38) and `validateSpeechPayload`
  (line 49): accept `payload.voice` only when it is `"male"`, `"female"` or undefined.
- `processVoice` (line 105): `formData.append("voice", payload.voice)` when set.
- `synthesize` (line 116): `voice: payload.voice` added to the JSON body.
- `buildRealtimeSocketUrl` (lines 161-166): adds the `voice` query parameter.
- Port handler (lines 281-284): reads `message.voice` on `start` and passes it to `connect`.
- Port handler (lines 291-293): forwards `{ type: "voice", voice }` to the socket.

### 7. Extension HUD — `extension/bridge.js`

The dropdown is the main UI piece. It mirrors the existing "Voice speed" select exactly.

**7a. Options constant** — next to `VOICE_RATES` (lines 78-84):

```js
const VOICES = [
  { value: "default", label: "Default" },
  { value: "male", label: "Male" },
  { value: "female", label: "Female" },
]
const DEFAULT_VOICE = "default"
```

**7b. State** — `state` object: `voice: DEFAULT_VOICE` (line 136).

**7c. Build the dropdown** — `buildVoicePicker()` (lines 254-270), next to `buildModeSwitch`:

```js
const buildVoicePicker = () => {
  const label = el("label", { className: "mai-visually-hidden", for: "mai-voice", text: "Voice" })
  const select = el(
    "select",
    { id: "mai-voice", className: "mai-select mai-select-block", "aria-describedby": "mai-voice-hint" },
    VOICES.map(({ value, label: text }) => el("option", { value, text }))
  )
  select.addEventListener("change", handleVoiceChange)
  const hint = el("p", {
    className: "mai-hint",
    id: "mai-voice-hint",
    text: "Male or female voice for the translation, in both directions.",
  })
  ui.voiceSelect = select
  return el("div", { className: "mai-voice-picker" }, [label, select, hint])
}
```

The visible label is visually hidden because the dropdown's own option text ("Male",
"Female") says what it is; the hint carries the explanation.

**7d. Place it in the HUD body** — in `buildHud`, above the mode switch (lines 339-343).

**7e. Change handler** — `handleVoiceChange` (lines 1835-1849):

```js
const handleVoiceChange = (event) => {
  const value = event.target.value
  state.voice = VOICES.some((option) => option.value === value) ? value : DEFAULT_VOICE
  event.target.value = state.voice
  storageSet({ voice: state.voice })
  // A running live interpreter can switch voice mid-sentence.
  if (state.realtime) {
    try {
      state.realtime.port?.postMessage({ type: "voice", voice: state.voice })
    } catch {
      // The port is gone; the next session picks the voice up.
    }
    setStatus(`Voice set to ${state.voice}. The live interpreter uses it from the next sentence.`, "success")
  }
}
```

**7f. Send it with every request** — three places build a request:

| Location | Payload | Add |
| --- | --- | --- |
| `buildTextClip` (line 974-975) | text clip for the browser-STT engines | `voice: state.voice` |
| CLIP handler (lines 2049-2050) | recorded clip | `voice: state.voice` |
| `playRemainingSentences` (lines 763-764) | `SYNTHESIZE` for sentences 2..n | `voice` argument, passed into the payload |

**7g. Play the backend's own speech** — `synth` message (lines 1524-1530):

```js
case "synth":
  // A chosen voice means the backend speaks the translation itself, so the
  // service's own audio is dropped and this MP3 is played instead.
  if (typeof message.audio === "string" && message.audio.length > 0) {
    postToInject("PLAY", { direction: "outgoing", audioBase64: message.audio })
  }
  break
```

**7h. Restore on load** — `init`: `"voice"` added to the `storageGet` key list (line 2114),
`state.voice` restored with the same allow-list check as `voiceRate` (line 2127), and
`ui.voiceSelect.value = state.voice` (line 2140).

**7i. Send the voice when the live session starts** — `port.postMessage({ type: "start", targetLang: session.targetLang, voice: state.voice })` (line 1563).

### 8. CSS — `extension/hud.css`

The dropdown reuses `.mai-select`, `.mai-select-block`, `.mai-visually-hidden` and `.mai-hint`.
One new rule lays the picker out as a column above the mode switch (lines 165-174):

```css
#meet-ai-hud .mai-voice-picker {
  display: flex;
  flex-direction: column;
  gap: var(--mai-space-1);
  min-width: 0;
}

#meet-ai-hud .mai-voice-picker .mai-hint {
  margin: 0;
}
```

### 9. Live interpreter path

The `realtime` engine (OpenAI live simultaneous interpretation) does **not** use the TTS
adapters — the service synthesizes the speech itself, and its session update accepts
`session.audio.output = { language }` **only**.

Probing the live translations API confirms it rejects every voice field:

```
session.audio.output.voice  -> Unknown parameter: 'session.audio.output.voice'. (code=unknown_parameter)
session.voice               -> Unknown parameter: 'session.voice'.
session.audio.voice         -> Unknown parameter: 'session.audio.voice'.
baseline                    -> ACCEPTED  output={"language":"en"}
```

So the voice is applied by the backend instead:

- `services/realtimeTranslate.ts` — `handleTranslateClient(client, targetLang, initialVoice)`.
  When a voice is picked, the service's audio is dropped and the translated text is spoken by
  our own TTS adapter in the chosen voice. The text is collected until a sentence ends (the
  service breaks mid-sentence), then synthesized one sentence at a time and sent as
  `{ type: "synth", audio, mime }`.
  - `useOwnVoice` (line 92) is `initialVoice !== "default" && !config.demoMode`.
  - `session.output_audio.delta` returns early when `useOwnVoice` (line 268).
  - `collectForSpeech` / `flushSpeech` (lines 144-162) accumulate until `SENTENCE_END` matches
    or the text passes 120 chars.
  - `drainSynthQueue` (lines 114-140) speaks one sentence at a time so order and gaps stay right.
  - `setVoice` (lines 166-174) handles mid-session switching; half-collected text is kept so no
    words are lost at the switch.
  - `finishAfterSpeech` (lines 200-218) holds the client open until the synth queue drains, so
    the last sentence is not lost.
  - A synthesis failure (line 127) reverts to the service voice and warns the user, rather than
    speaking with the wrong voice.
- `server.ts:96` — reads the `voice` query parameter next to `target` and passes it to
  `handleTranslateClient(client, target, voice)`.
- `background.js` (`buildRealtimeSocketUrl`) — adds the `voice` query parameter.
- `bridge.js` — sends `voice: state.voice` in the port `start` message and plays the
  `synth` message through the normal `PLAY` path.

`voice=default` keeps the service's own audio, which is lower latency and unchanged. The voice
can also be switched mid-session with a `{ type: "voice", voice }` message, so the dropdown
takes effect from the next sentence without restarting the interpreter.

Note: the live path is the default engine (`DEFAULT_ENGINE = "realtime"`, `bridge.js`),
so without this step the picker would look broken to the user.

### 10. Config docs

- `backend/.env.example` — real male/female env vars for Edge and OpenAI, plus the
  `TTS_PROVIDER` list fixed to include `google-translate`, which is a valid value.
- `PROJECT_DOCUMENTATION.md` — the new settings in the settings table, the `voice` field in the
  request contract, the `synth` message, the `voice` WebSocket message, and the gender-aware
  fallback chain.

## Files touched

Extension:
- `extension/bridge.js` — the "Voice" dropdown: options constant, `state.voice`,
  `buildVoicePicker()`, placement above the mode switch, change handler, restore on load, the
  `synth` playback path, and `voice` added to the request payload sites.
- `extension/background.js` — validate the `voice` value, forward it to the backend, send it in
  the realtime socket URL and on mid-session switch.
- `extension/hud.css` — the `.mai-voice-picker` layout rule.

Backend:
- `backend/src/types.ts` — `Voice`, `TtsOptions.voice`, `ProcessVoiceRequest.voice`,
  `TtsAdapter.supportsGender`
- `backend/src/config.ts` — `edge.voices` becomes `{male, female}` per lang; add
  `openai.ttsVoices`, `elevenlabs.voiceIds`
- `backend/src/lib/validation.ts` — `parseVoice()`
- `backend/src/adapters/tts/{edgeTts,openai,elevenlabs,customHttp,googleTranslate}.ts` —
  honor `options.voice`, declare `supportsGender`
- `backend/src/adapters/tts/index.ts` — `withChain` replaces `withFallback`
- `backend/src/routes/{processVoice,speech}.ts` — parse and pass it
- `backend/src/services/aiService.ts` — thread it through both call sites
- `backend/src/services/realtimeTranslate.ts` + `backend/src/server.ts` — live interpreter
  (step 9), otherwise the default engine ignores the dropdown
- `backend/.env`, `backend/.env.example` — real male/female env vars

## Verification

1. Backend typecheck and build: `npm run typecheck && npm run build` in `backend/`.
2. Manual API check:
   - `POST /api/tts` with `{"text":"Hello","lang":"en","voice":"male"}` and the same with
     `"voice":"female"` -> two different mp3 payloads. Compare bytes; they must differ.
   - `POST /api/process-voice` multipart with `voice=female` -> `audio_base64` present.
   - Invalid value `voice=banana` -> must not error, falls back to the default voice.
3. Extension dropdown:
   - Open the HUD panel. The "Voice" dropdown must show Default / Male / Female,
     directly above the Hands-free / Push-to-talk buttons.
   - Pick "Male", speak. The client must hear a male voice.
   - Switch to "Female" mid-meeting: the next sentence must use the new voice.
     (Audio already queued keeps the old voice — that is expected.)
   - Pick "Default": the provider's configured voice is used again.
4. Persistence: reload the Meet tab. The dropdown still shows the last choice, and the next
   request still uses that voice. Also confirm the choice survives a browser restart
   (`chrome.storage.local` is persistent).
5. Both directions: incoming (client's words read to you in Bangla) and outgoing (your
   Bangla played to the client) use the selected gender.
6. Fallback check: set `TTS_PROVIDER=edge` and force a 429 to confirm the fallback path
   (`withChain`, `adapters/tts/index.ts`) still works with the extra `voice` option.

## Risks and notes

- **Edge rate limiting**: opening a second websocket for the other gender doubles the
  connection count. `connections`/`queues` are per voice, so switching voices opens one
  extra socket and keeps it cached. Acceptable.
- **OpenAI model vs. latency**: `gpt-4o-mini-tts` is slower than `tts-1`, but its male/female
  voices are clearly separated. Set `OPENAI_TTS_MODEL=tts-1` if latency matters more than the
  gender difference.
- **ElevenLabs**: needs two voice ids in `.env`; with only one id configured, both genders
  resolve to that id.
- **google-translate fallback** ignores gender — it is skipped entirely for a gender request
  (see below), so this only affects the `default` voice.

### The gender-blind fallback (why "Male" sounded wrong)

The first build sent `voice` to the fallback provider unchanged. `google-translate` has no
voice parameter, so when Edge failed, **every** gender fell back to the same genderless
voice — the dropdown looked broken. The reported symptom was exactly that: "Male" produced
no male voice, but "Default" produced a male voice (the genderless fallback happens to sound
male), while "Female" worked because it went through a different path.

`TtsAdapter` now carries `supportsGender`. `withChain` (in `adapters/tts/index.ts`) filters the
provider chain before trying it, so any provider that cannot deliver the requested gender is
skipped and the next one that can is used (OpenAI TTS, when an API key is configured). If
nothing can, the request fails loudly instead of speaking with the wrong voice.

An earlier attempt at this used `withFallback(backup, genderBackup)`. That was wrong: it made
`google-translate` the *primary* of the inner chain, so it succeeded and OpenAI was never
reached — all three voices stayed identical. `withChain` filters first, then tries.

Reproduced with the shipped config (`TTS_PROVIDER=edge`, `TTS_FALLBACK_PROVIDER=google-translate`),
where Edge's websocket is unreachable from this network:

```
before:  male sha=98c547ae56897fef  female sha=98c547ae56897fef  default sha=98c547ae56897fef
after:   male sha=ca2607b44da546f3  female sha=00ca573e1a3ad0e5  default sha=bbb23a7963ea291e
```

and through the realtime websocket:

```
default  synth=0 serviceAudio=5
male     synth=4 serviceAudio=0
female   synth=5 serviceAudio=0   (different audio from male)
```

The live backend log confirms the chain now picks a gender-capable provider:

```
TTS edge-tts failed, using openai-tts      <- male / female request
TTS edge-tts failed, using google-translate <- default request
```

**Edge TTS is unreachable from this network** (`Edge TTS WebSocket error: Unexpected server
response: 200`), so the primary provider always fails here and the gender fallback takes
over. The same failure was reproduced on the unmodified code, so it is environmental, not
caused by this change.

### The Female voice sounded like Male

After the gender-blind fallback was fixed, "Female" was audible but too close to "Male".
The cause was the OpenAI model, not the plumbing: `tts-1`'s `onyx` (male) and `shimmer`
(female) voices are too similar to tell apart by ear.

Probing the models directly showed `gpt-4o-mini-tts` has clearly separated voices and
accepts `instructions`:

```
gpt-4o-mini-tts  onyx      bytes=77568
gpt-4o-mini-tts  coral     bytes=93696
gpt-4o-mini-tts  verse     bytes=85632
gpt-4o-mini-tts  ballad    bytes=101760
tts-1            onyx      bytes=34560
tts-1            shimmer   bytes=34176
```

The fix was two parts:

1. `OPENAI_TTS_MODEL` switched back to `gpt-4o-mini-tts`, and `OPENAI_TTS_VOICE_FEMALE`
   switched from `shimmer` to `coral`.
2. `backend/src/adapters/tts/openai.ts` appends an explicit gender instruction to the
   configured tone, so the model reinforces the intended gender:

```ts
const GENDER_INSTRUCTIONS: Record<Exclude<Voice, "default">, string> = {
  male: "Speak with a clearly male voice: an adult man with a deeper, steady voice.",
  female: "Speak with a clearly female voice: an adult woman with a brighter, warmer voice.",
}
```

The gender wording is only sent on the `gpt-4o*` models — `tts-1` rejects the `instructions`
field — so `buildInstructions` returns `{}` for anything else.

## What was verified

Backend `npm run typecheck` and `npm run build` pass. Extension `node --check` passes on
`bridge.js` and `background.js`.

Voice resolution, per adapter (checked with the network stubbed so no provider was called):

| Adapter | male | female | default |
| --- | --- | --- | --- |
| edge | `en-US-GuyNeural` | `en-US-AriaNeural` | `en-US-AriaNeural` |
| openai | `onyx` | `coral` | `ash` |
| elevenlabs | `ELEVENLABS_VOICE_ID_MALE` | `ELEVENLABS_VOICE_ID_FEMALE` | `ELEVENLABS_VOICE_ID` |
| custom | `male` | `female` | `default` |

End-to-end through the running API, first with `tts-1` (`onyx` / `shimmer`) — the female voice
was audible but too close to the male:

```
male     bytes=32640   sha=2fa214324969b87e
female   bytes=33792   sha=7cf8aa65e9e09dd7
default  bytes=32256   sha=79323c6fe681f9c1
bogus    bytes=29184   sha=8affb358ac20d2f1
```

Re-verified after the switch to `gpt-4o-mini-tts` (`onyx` / `coral`) on the rebuilt backend
(PID 12536, `node dist/server.js`):

```
/api/tts
male     bytes=96301   sha=34bf2569c9c7
female   bytes=120877  sha=cb5dccbda1d1
default  bytes=63277   sha=cc61e2a10988
bogus    bytes=63277   sha=cc61e2a10988   (same as default -> falls back, no error)

/api/process-voice
male     bytes=64128   sha=db202e38e6de
female   bytes=47232   sha=56eca8f44ac7
default  bytes=24576   sha=7a2b91fbc4d2
```

`bogus` is an invalid value that falls back to the default voice rather than erroring.

The live interpreter path was verified against a fake OpenAI upstream (a local WebSocket
that replays transcript deltas and audio, and a local `custom` TTS provider that echoes
the requested voice):

```
default  types=[ready,source_delta,translation_delta,audio,closed]  synth=0 audio=6
male     types=[ready,source_delta,translation_delta,synth,closed]  synth=2 audio=0  sha=bca933959387185b
female   types=[ready,source_delta,translation_delta,synth,closed]  synth=2 audio=0  sha=79ff082b6493c8b2
```

- `default` keeps the service's PCM audio and sends no `synth` message.
- `male` and `female` drop the service's audio and send one `synth` message per sentence
  ("Hello there." then "This is a test."), in order.
- The two voices produce different audio.
- Switching the voice mid-session works: a session started on `male` and switched to `female`
  after two seconds produced `male, male, female, female, female` — the change lands on the
  next sentence, with no restart. Switching back to `default` hands the audio back to the
  service, which then plays its own voice again.

A real 228-second live session confirmed it end to end against the actual OpenAI service:

```
[live ja] session starting (gpt-realtime-translate), voice=female
[live ja] spoke: こんにちは、皆さん。
[live ja] spoke: 今は何してるの?
[live ja] voice changed to default
[live ja] voice changed to male
[live ja] spoke: 君ん家の人たちも、元気だよ。
[live ja] voice changed to female
[live ja] spoke: 僕は、みんなに会いたいよ。
```

Every switch took effect on the next sentence, in the requested voice, without restarting
the interpreter.

**Not verified:** the dropdown in a live Meet tab, and the Edge TTS provider end to end.
Edge's WebSocket returns "Unexpected server response: 200" from this machine, so every
Edge request falls back to another provider. The same failure was reproduced on the
unmodified code (checked out via `git stash`), so it is environmental — Microsoft blocks this
network — and not caused by this change. The Edge adapter's voice mapping itself was
verified with the network stubbed.
