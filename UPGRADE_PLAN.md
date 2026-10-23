# Meet AI Interpreter: Reliability & Quality Upgrade Plan

লক্ষ্য: জাপানিজ ক্লায়েন্ট **প্রতিটা কথা শুনবে**, host **কোনো লাইন হারাবে না**, দুইজন একসাথে বললে **গুছিয়ে** সামলাবে, আর **কখনো stop/start করতে হবে না**।

> এই প্ল্যান কোড পড়ে বানানো। কারণগুলো (বিশেষ করে ⚠ চিহ্নিতগুলো) Phase 0-এর ledger চালু হলে প্রমাণসহ নিশ্চিত হবে। তাই Phase 0 আগে।

---

## 1. সমস্যা → মূল কারণ → সমাধান (একনজরে)

| # | লক্ষণ | মূল কারণ (কোড) | সমাধান ফেজ |
|---|---|---|---|
| A | কিছুক্ষণ পর থেমে যায়, stop/start লাগে | Extension↔backend WS-এ auto-reconnect নেই ([bridge.js:1136](extension/bridge.js), [bridge.js:1321](extension/bridge.js), [background.js:230](extension/background.js)); backend-এ heartbeat নেই ([server.ts:58](backend/src/server.ts)); `playBuffer` `onended`-এ আটকে যেতে পারে, queue/`duckCount` reset হয় না ([inject.js:780](extension/inject.js)); MV3 SW eviction | P1, P5 |
| B | ক্লায়েন্ট বলছে, অনেক লাইন অনুবাদ হয় না | ব্যর্থ clip-এ retry নেই, শুধু ১টা `failedClip` ([bridge.js:744](extension/bridge.js)); `empty` নীরবে বাদ ([bridge.js:764](extension/bridge.js)); প্রতি বাক্যে ৩ call (translate+analysis+TTS) → 429; head-of-line blocking; playback backlog অসীম; Meet অডিও পুরো mute; captions DOM-diff ভঙ্গুর ([captions.js:54](extension/captions.js)); ⚠ Whisper `completed` merge ([realtimeTranscribe.ts:247](backend/src/services/realtimeTranscribe.ts)) | P0, P1, P2 |
| C | দুইজন একসাথে বললে confusion/missing | Floor-control নেই; `flushOthers` অসম্পূর্ণ বাক্য কাটে ([captions.js:151](extension/captions.js)); সব ক্লায়েন্ট এক mix-এ; host-এর মাথার ওপর আগের বাংলা ভয়েস | P3 |
| D | জাপানিজ ক্লায়েন্টের কাছে "সব শব্দ" পৌঁছায় না/অস্বাভাবিক লাগে | Live path-এ glossary/instruction নেই ([realtimeTranslate.ts:44](backend/src/services/realtimeTranslate.ts)); audio drop নীরব; `ScriptProcessor` glitch; jitter buffer ~৮০ms; TTS ভয়েস জাপানিজ-টিউনড নয় | P0, P4, P5 |
| E | উন্নতি মাপা/ধরার উপায় নেই | Metrics/test/session log নেই; `bridge.js` ৭৩KB একটা ফাইল | P0, P6 |

---

## 2. সফলতার মাপকাঠি (Definition of Done)

| মেট্রিক | এখন | লক্ষ্য |
|---|---|---|
| Completeness (বলা বাক্যের কত % অনুবাদ+প্লে হয়) | অজানা | **≥ 98%** |
| নীরবে হারানো লাইন | অজানা | **0** (যা ব্যর্থ হয় তা UI-তে দৃশ্যমান) |
| ২ ঘণ্টার সেশনে ম্যানুয়াল stop/start | প্রায়ই | **0 বার** |
| নেটওয়ার্ক/backend ছেঁড়ার পর স্বয়ংক্রিয় recovery | নেই | **≤ 5 সেকেন্ড** |
| Latency (বাক্য শেষ → অনুবাদের ভয়েস শুরু), p95 | ~২-৩s+ | **≤ 3.5s** |
| Backlog (পিছিয়ে থাকা) | সীমাহীন | **≤ 8s**, এরপর text-only/সংক্ষেপ |
| Overlap-এ বাক্য কেটে যাওয়া | হয় | **0** (বাক্য সম্পূর্ণ হয়ে তবেই যায়) |
| সংখ্যা/তারিখ/নাম ঠিক (golden set) | অজানা | **≥ 98%** |

---

## 3. কর্মপদ্ধতি

- প্রতিটা ফেজ **feature flag** (`chrome.storage` + backend env) দিয়ে, যাতে লাইভ মিটিংয়ে ঝুঁকি ছাড়া চালু/বন্ধ করা যায়।
- প্রতিটা ফেজ শেষে **fault-injection test** (নিচে §10) পাস না করলে পরের ফেজে না।
- পুরোনো `/api/process-voice` ও protocol **backward-compatible** থাকবে যতক্ষণ না P5 শেষ হয়।

---

## Phase 0: দৃশ্যমানতা ও মাপজোক (২-৩ দিন) ⟵ আগে এটা

**কেন:** না মেপে ঠিক করলে আবার অনুমানে ঘুরতে হবে।

### 0.1 Utterance Ledger (extension, `bridge.js`)
প্রতিটা উক্তির একটা `utteranceId` ও state machine:

```
captured → submitted → translated → voiced → played
                  ↘ failed(reason, retries) ↘ dropped(reason)
```

- `reason`: `http_429`, `timeout`, `empty_translation`, `tts_failed`, `gated_muted`, `gated_playback`, `stale_skipped`, `ws_dropped` ইত্যাদি।
- Ledger-এ থাকবে: speaker, src text, translated text, timestamps (`t_captured`, `t_translated`, `t_played`), retries।
- UI: panel-এ ছোট **health bar**: `✔ 42 played · ⚠ 2 failed · ⏳ 1 queued`। ⚠ ক্লিক করলে ব্যর্থ লাইনের তালিকা।

### 0.2 Audio drop counters
- `inject.js`: পাঠানো ফ্রেম, gated (silence পাঠানো) ফ্রেম গণনা।
- Backend: `queue.shift()` drop ([realtimeTranslate.ts:239](backend/src/services/realtimeTranslate.ts), [realtimeTranscribe.ts:349](backend/src/services/realtimeTranscribe.ts)) গুনে client-কে `warn` পাঠানো (`dropped_ms`)।
- Panel-এ: "⚠ ২ সেকেন্ড অডিও হারিয়েছে"।

### 0.3 Backend structured log ও Sentry
- প্রতি request/session-এ `sessionId`, `utteranceId`, stage timings, error class।
- Sentry-তে error + latency পাঠানো (Sentry MCP ইতিমধ্যে আছে)।
- Session শেষে JSON log (ব্যর্থতার কারণ-সহ) ডাউনলোডযোগ্য: bug report ও meeting audit দুটোতেই কাজে লাগবে।

### 0.4 Debug overlay (ডেভেলপার মোড)
RTT, WS অবস্থা, in-flight সংখ্যা, backlog সেকেন্ড, audio RMS, caption-source সুস্থতা।

**Exit criteria:** একটা টেস্ট মিটিংয়ের পর বলা যায়, কোন স্তরে কত লাইন কেন হারিয়েছে।

---

## Phase 1: স্থিতিশীলতা: stop/start বন্ধ + নীরব হারানো বন্ধ (৩-৪ দিন)

### 1.1 Auto-reconnect + heartbeat (সমস্যা A)
- **Protocol যোগ:** `ping/pong` (প্রতি ৫s, দুই দিকে), `seq` (প্রতি audio frame), `ack`, `resume { sessionId, lastAckSeq }`।
- **Backend** ([server.ts](backend/src/server.ts)): `ws` ping/pong; ১৫s সাড়া না এলে connection terminate; session state `sessionId` দিয়ে ৩০-৬০s ধরে রাখা (resume-এর জন্য)।
- **Extension** ([bridge.js](extension/bridge.js), [background.js](extension/background.js)): unexpected close হলে exponential backoff (0.5s→1→2→4, সর্বোচ্চ ~১ মিনিট) সহ **স্বয়ংক্রিয় reconnect**। শুধু ইউজার stop করলে বা auth ব্যর্থ হলে থামবে।
- **Audio ring buffer** (extension বা backend): `lastAckSeq`-এর পরের অংশ reconnect-এ আবার পাঠানো (সর্বোচ্চ ~১৫s)। নীরবে `shift()` করে ফেলে দেওয়া বন্ধ; সীমা পেরোলে ledger-এ `dropped(ws_dropped)` + UI warning।
- Backend↔OpenAI reconnect-এ **শেষ কয়েক সেকেন্ডের transcript context** নতুন session-এ বীজ হিসেবে দেওয়া (মাঝবাক্যে কাটলে অর্থ ভাঙা কমবে)।
- UI status: `● Connected / ◐ Reconnecting… / ○ Offline` (লাল/হলুদ/সবুজ)।

### 1.2 Epoch (generation) দিয়ে stale chain বাতিল
- প্রতিটা start-এ `epoch++`। `directionState.chain`, `playQueues`, timers সব epoch-ট্যাগড; পুরোনো epoch-এর ফলাফল ফেলে দেওয়া।
- Stop/start-এ chain ও play queue **পুরোপুরি reset**। (এখন reset হয় না, শুধু page refresh-এ হয়।)

### 1.3 Playback নিরাপত্তা ([inject.js](extension/inject.js))
- `playBuffer`-এ timeout = `buffer.duration + 1s`; `onended` না এলে জোর করে resolve + warning।
- `duckMeetAudio/restoreMeetAudio` সবসময় `try/finally`; `duckCount` stuck হলে watchdog দিয়ে ০ করা।
- AudioContext `suspended` ধরা পড়লে অটো `resume()`; না হলে "একবার ক্লিক করুন" prompt।

### 1.4 নীরব ব্যর্থতা বন্ধ + auto-retry (সমস্যা B)
- `deliverResponse`-এ: `!ok` / `empty` / `voice_error` সবকিছু ledger-এ রেকর্ড।
- **Auto-retry:** ২ বার, backoff (০.৮s, ২s); ৩য়বারে provider fallback (§P2.4)।
- শেষ পর্যন্ত ব্যর্থ হলে log-এ **placeholder কার্ড**: "⚠ এই লাইন অনুবাদ হয়নি: `<src text>` [আবার চেষ্টা]"। অন্তত source টেক্সট সবসময় দেখানো।
- `failedClip` একটা নয়, **তালিকা**।

### 1.5 Concurrency limit ও timeout কাঠামো
- In-flight সর্বোচ্চ ২-৩ (client-side semaphore)।
- Per-request timeout কমানো (30s → translate ১০s, TTS ৮s) যাতে একটা আটকে বাকিদের আটকে না রাখে।
- **Head-of-line blocking কমানো:** ফলাফল ক্রমে *দেখানো/বাজানো*, কিন্তু একটা ব্যর্থ হলে `N` সেকেন্ডের বেশি পরেরগুলোকে আটকে না রাখা (placeholder বসিয়ে এগিয়ে যাওয়া)।

### 1.6 Meet-এর আসল অডিও পুরো mute নয়
- `muteClientOriginal`-এর বদলে **duck ~১৫-২৫%** (ডিফল্ট), সেটিংয়ে বদলানো যাবে ([inject.js:256](extension/inject.js))।
- কারণ: host অন্তত বুঝবে ক্লায়েন্ট কথা বলছে, আর ভয়েস পিছিয়ে/হারিয়ে গেলেও সে অন্ধ হবে না।

**Exit criteria:** §10-এর "backend kill", "WiFi switch", "429 injection", "AudioContext suspend" টেস্ট পাস; ২ ঘণ্টা ম্যানুয়াল হস্তক্ষেপ ছাড়া।

---

## Phase 2: সম্পূর্ণতা: কোনো লাইন বাদ পড়বে না (৫-৭ দিন)

### 2.1 প্রতি বাক্যে call কমানো
- **Analysis আলাদা:** এখন প্রতি incoming বাক্যে সবসময় চলে ([aiService.ts:99](backend/src/services/aiService.ts))। পরিবর্তন: turn শেষে বা অন-ডিমান্ডে ("সাজেশন" বোতাম), বা প্রতি ২-৩ বাক্যে একবার।
- ফলে বাক্য-প্রতি call ৩ → ২ (translate + TTS)।

### 2.2 ছোট বাক্য merge (batching)
- একই speaker-এর ১ সেকেন্ডের মধ্যে আসা ছোট খণ্ড একসাথে এক request-এ।
- সর্বোচ্চ আকার/অপেক্ষা সীমা রেখে (latency নষ্ট না করে)।

### 2.3 Backlog ও staleness নীতি
- Backlog (পিছিয়ে থাকা) ≥ ৮s হলে ক্রমান্বয়ে:
  1. TTS বাদ → text-only (ledger: `stale_skipped`, কিন্তু text দেখানো হয়, অর্থাৎ হারায় না)।
  2. ≥ ১৫s হলে অপেক্ষমাণ বাক্যগুলো **একসাথে সংক্ষেপ করে** এক ভয়েসে।
- Playback gap-হীন রাখতে বাংলা ভয়েসের গতি ১.১-১.২× পর্যন্ত বাড়ানো (adaptive)।

### 2.4 Provider fallback ও TTS নির্ভরযোগ্যতা
- LLM: primary → secondary (যেমন OpenAI → Gemini; adapter ইতিমধ্যে আছে)।
- TTS: Edge (অনানুষ্ঠানিক, 429) → ক্লায়েন্ট-ক্রিটিক্যাল কলে paid TTS প্রাইমারি। Fallback chain + circuit breaker (আপনার ৬০s skip-নীতি সম্প্রসারণ)।
- ব্যর্থ TTS-এও অন্তত Bangla text দেখানো নিশ্চিত।

### 2.5 Captions pipeline নতুন করে ([captions.js](extension/captions.js))
- **Speaker-wise আলাদা buffer ও state**; `flushOthers` সরানো।
- "Commit" নিয়ম: বাক্য-শেষ চিহ্ন + `N` ms অপরিবর্তিত; অথবা pause।
- `findSentEnd`-এর fallback উন্নত: anchor না পেলে শুধু শেষ ৩৫০ অক্ষর নয়, বরং লেজার (ledger) দেখে **কোন অংশ পাঠানো হয়েছে** তার ভিত্তিতে বাদ পড়া অংশ চিহ্নিত করে পাঠানো। Duplicate রোধে হ্যাশ।
- **Health check:** region না পেলে/বদলালে অটো re-attach + UI সংকেত। ৩s নয়, ধারাবাহিক নজরদারি।
- **Completeness watchdog:** incoming bus-এ অডিও এনার্জি আছে কিন্তু captions থেকে N সেকেন্ডে টেক্সট নেই → স্বয়ংক্রিয়ভাবে Whisper path ফলব্যাক চালু (এবং ফিরে এলে বন্ধ)।

### 2.6 Whisper live path ঠিক করা ([realtimeTranscribe.ts](backend/src/services/realtimeTranscribe.ts))
- ⚠ `completed` merge যাচাই: লগ করে দেখা পুরো-turn টেক্সট আসে কিনা। এলে, ইতিমধ্যে emit করা অংশ বাদ দিয়ে (offset ট্র্যাক করে) শুধু নতুন অংশ পাঠানো, যাতে duplicate না হয়।
- জাপানিজের জন্য: মাঝ-বাক্য ৮০০ms flush ([realtimeTranscribe.ts:22](backend/src/services/realtimeTranscribe.ts)) পুনর্বিবেচনা। ক্রিয়া শেষে আসে বলে বাক্য-শেষ বা দীর্ঘতর pause পর্যন্ত অপেক্ষা; আর partial হলে `partial: true` ফ্ল্যাগসহ context দিয়ে অনুবাদ।

### 2.7 ছোট কিন্তু গুরুত্বপূর্ণ
- `empty` রেসপন্স আর নীরবে বাদ নয়। কেন empty তা ledger-এ (noise/filler হলে `dropped(noise)`)।
- SW-তে `MAX_TEXT_LENGTH` ১০০০ অতিক্রম করলে বাদ না দিয়ে **ভেঙে পাঠানো**।

**Exit criteria:** golden-set ও 30-মিনিটের সিমুলেটেড ক্লায়েন্ট-কথনে completeness ≥ 98%, duplicate ≈ 0।

---

## Phase 3: একসাথে কথা বলা (Floor Control) (৫-৭ দিন)

### 3.1 Floor-control state machine
```
IDLE ─ host speaks ─▶ HOST
IDLE ─ client speaks ─▶ CLIENT(name)
HOST/CLIENT ─ other starts ─▶ OVERLAP ─ one stops ─▶ resolves per policy
```
- **Policy (সেটিং):** `Auto` (ডিফল্ট), `Host-first`, `Client-first`।
- **Auto:** যে আগে শুরু করেছে সে পালা পায়; অন্যজনের অনুবাদ **queued** (text চলতে থাকে, ভয়েস অপেক্ষায়)।
- Overlap শেষে queued ভয়েস চালানো; পুরোনো (stale) হলে §2.3 নীতি।
- Overlap-এর সময় **কোনো বাক্য মাঝপথে কাটা হবে না**: শুধু প্লে/ডেলিভারি পিছোবে।

### 3.2 Overlap শনাক্তকরণ
- Host: mic VAD ([inject.js](extension/inject.js)) + live interpreter-এর source delta।
- Client: captions activity (speaker-wise) বা incoming bus RMS।
- Hysteresis (যেমন ২০০-৩০০ms) যাতে "আ-হা" জাতীয় ছোট শব্দে ঘনঘন বদলাতে না থাকে।

### 3.3 Speaker-wise ভয়েস ও দৃশ্যমানতা
- প্রতি ক্লায়েন্ট speaker-কে আলাদা বাংলা TTS ভয়েস (পুরুষ/নারী/ভিন্ন সুর); speaker-নাম ও রঙ log-এ।
- Panel-এ লাইভ ইন্ডিকেটর: "🗣 Tanaka বলছেন · 🗣 আপনি (queued)" ও "⚠ ওভারল্যাপ"।

### 3.4 Outgoing-এ সংযম
- Host-first না হলে, ক্লায়েন্ট বলার সময় host-এর অনুবাদ জাপানিজে **ক্লায়েন্টের কথার ওপর** ঠেলে না দিয়ে ছোট বিলম্ব/hold (সেটিং: `চুপ করা পর্যন্ত অপেক্ষা` / `সবসময় পাঠাও`)।
- Headphone অফ মোডে গেটিং এর কারণে host-এর বাক্য ফেলে না দিয়ে **queued থাকা ও পরে পাঠানো** (এখন কিছু path-এ ফেলে দেওয়া হয়: [bridge.js:879](extension/bridge.js))।

### 3.5 ঐচ্ছিক (পরে)
- Stereo pan: ক্লায়েন্টের অনুবাদ এক কানে, নিজের কথার echo-monitor অন্য কানে।
- Per-participant ASR শুধু যেখানে Meet আলাদা stream দেয় (সাধারণত সবাইকে আলাদা পাওয়া যায় না, তাই captions প্রধান)।

**Exit criteria:** §10-এর overlap স্ক্রিপ্ট (host+client, client+client, host বলছে যখন বাংলা বাজছে) চালিয়ে কোনো বাক্য কাটা/হারানো নেই; ordering সঠিক।

---

## Phase 4: জাপানিজ ক্লায়েন্টের জন্য মান (৫-৮ দিন)

### 4.1 Live path-এ নিয়ন্ত্রণ
- OpenAI live translate session-এ **instruction/glossary/keigo স্তর** পাঠানো যায় কিনা API ডকুমেন্টেশনে যাচাই। যায় হলে `buildSessionUpdate` ([realtimeTranslate.ts:44](backend/src/services/realtimeTranslate.ts)) এ যোগ।
- না গেলে → **Cascade engine** (§4.2) ফলব্যাক হিসেবে।

### 4.2 Cascade engine (নতুন, ঐচ্ছিক ইঞ্জিন)
```
Mic → streaming Bangla ASR → stable-prefix segmentation
    → LLM (glossary + keigo + context + সংখ্যা-নিয়ম) → streaming JA TTS → virtual mic
```
- বাংলা ASR তুলনা: Google Chirp, Azure, ElevenLabs Scribe, বর্তমান `gpt-realtime-whisper` (আপনার ১০-২০ বাক্যের golden set দিয়ে)।
- Live = দ্রুত/স্বাভাবিক আলাপ; **Precise মোড** = বাক্য সম্পূর্ণ হলে শক্তিশালী LLM + সংখ্যা/তারিখ/না-বোধক থাকলে host-কে **confirmation card**।
- Auto-failover: Live ব্যর্থ হলে Cascade/sentence mode-এ স্বয়ংক্রিয় নামা (এখন হাতে বদলাতে হয়)।

### 4.3 ভাষাগত নিয়ম (prompt/glossary)
- সংখ্যা: লাখ → 10万, কোটি → 1000万 (ও উল্টোটা); তারিখ/মুদ্রা (円/万円) normalization।
- Glossary-তে নাম + kanji + hiragana reading; TTS-এ reading পাঠানো (田中 → たなか)।
- Keigo স্তর per-client সেটিং (取引先 / অভ্যন্তরীণ); 御社/弊社, させていただきます ইত্যাদি।
- জাপানি বাক্য-শেষ/ক্রিয়া অপেক্ষার নিয়ম (§2.6) incoming prompt-এও।

### 4.4 TTS ভয়েস ও playback মান
- জাপানি ভয়েস তুলনা: Azure `ja-JP-Nanami/Masaru`, ElevenLabs, Google Chirp 3 HD বনাম বর্তমান `tts-1/ash`।
- Adaptive **jitter buffer** (১৫০-৩০০ms) ([inject.js:717](extension/inject.js)); backlog বাড়লে ১.১-১.২× catch-up।
- Virtual mic-এ অতি-নিম্ন **comfort noise** চালু রাখা, যেন Meet/Opus DTX প্রথম শব্দাংশ না কাটে।

### 4.5 Subtitle লিংক (ক্লায়েন্ট কিছু install না করে)
- Backend `GET /s/<sessionToken>` পেজ: লাইভ জাপানি টেক্সট (WS), শুনতে সমস্যা হলে ব্যাকআপ। "প্রতিটা কথা" নিশ্চিত করার সস্তা উপায়।
- Token short-lived, session শেষে মেয়াদ শেষ।

### 4.6 Consent ও গোপনীয়তা
- মিটিং শুরুতে "AI interpreter ব্যবহার হচ্ছে" নোটিশ টেমপ্লেট।
- Provider data-retention/DPA নোট ডকুমেন্টে; audio কখনো ডিস্কে নয় (এখনকার নীতি বজায়)।

**Exit criteria:** golden-set-এ সংখ্যা/নাম ≥ 98%; ২-৩ জন জাপানি-ভাষী/প্রকৃত ক্লায়েন্টের ব্লাইন্ড ফিডব্যাক (স্বাভাবিকতা ≥ 4/5)।

---

## Phase 5: আর্কিটেকচার আধুনিকীকরণ (১.৫-২.৫ সপ্তাহ)

### 5.1 Offscreen document + AudioWorklet
- Mic capture, resampling, PCM16 framing ও **WebSocket** চলবে **offscreen document**-এ (MV3-এর অফিসিয়াল উপায়)। SW eviction সমস্যা শেষ; main-thread glitch (`ScriptProcessor`) শেষ।
- Incoming অডিওতে `srcObject` hook-এর পাশাপাশি/বদলে `chrome.tabCapture`।
- Page script পাতলা: শুধু virtual mic inject + playback।
- Audio **binary frame** (base64+JSON নয়, ~৩৩% সাশ্রয়)।

### 5.2 Backend শক্তিশালীকরণ
- Session store (context, glossary, client profile, ledger) সার্ভারে।
- WS auth: query token বদলে short-lived ticket / header; query token log-এ leak বন্ধ।
- Production: hosted + TLS, per-user auth, rate-limit, `HOST=127.0.0.1` ডিফল্ট থেকে ডিপ্লয় কনফিগ।
- Health/metrics endpoint (`/health` সম্প্রসারিত: RTT, active sessions, error rate)।

### 5.3 কোড-কাঠামো
- **TypeScript + bundler** (WXT বা Vite) দিয়ে extension।
- `bridge.js` ভাঙা: `ui/`, `settings/`, `session/` (live, captions, ptt), `ledger/`, `protocol/`।
- Protocol schema **zod** দিয়ে, extension ও backend-এর মধ্যে শেয়ার্ড।
- Session lifecycle explicit state machine (XState বা সমতুল্য)।

**Exit criteria:** পুরোনো ফিচার সব কাজ করে (regression-free); ৪ ঘণ্টার সেশনে stable।

---

## Phase 6: টেস্ট হারনেস (Phase 0-র সাথে সমান্তরালে শুরু, চলমান)

### 6.1 Golden set
- ২০-৫০টি আসল **কথ্য বাংলা** বাক্যের রেকর্ডিং + কাঙ্ক্ষিত জাপানি অনুবাদ (সংখ্যা, নাম, না-বোধক, ইংরেজি tech শব্দসহ)।
- ২০-৩০টি জাপানি→বাংলা উদাহরণ (লম্বা বাক্য, keigo, সংখ্যা)।

### 6.2 Replay স্বয়ংক্রিয় টেস্ট
- রেকর্ড করা অডিও পাইপলাইনে ঢুকিয়ে: completeness, সংখ্যা-সঠিকতা, latency, duplicate গণনা।
- প্রতিটা পরিবর্তনে CI-তে চালিয়ে regression ধরা (prompt বদলালে ভালো/খারাপ বোঝা যাবে)।

### 6.3 ইউনিট টেস্ট
Resampler, VAD, segmentation (জাপানি/ইংরেজি বাক্য-সীমা), caption diff (`findSentEnd`), floor-control, retry/backoff।

---

## 10. Fault-injection ও দৃশ্যকল্প চেকলিস্ট (প্রতি ফেজে)

| টেস্ট | প্রত্যাশা |
|---|---|
| Backend প্রসেস মাঝপথে kill + ৫s পর চালু | ≤ ৫s-এ অটো reconnect; হারানো অংশ replay বা ledger-এ দৃশ্যমান |
| Wi-Fi বদল / ১০s অফলাইন | Reconnecting দেখায়, ফিরে অটো চালু, ম্যানুয়াল বোতাম নয় |
| OpenAI/Edge TTS-এ 429 ইনজেক্ট (৩০% request) | retry/fallback; কোনো লাইন নীরবে হারায় না |
| একটা request ৩০s ঝুলিয়ে রাখা | পরের লাইনগুলো আটকে থাকে না |
| AudioContext জোর করে suspend | অটো resume বা স্পষ্ট prompt; Meet অডিও আটকে mute থাকে না |
| Meet captions বন্ধ/ভাষা বদল/layout বদল | অটো re-attach বা Whisper ফলব্যাক, UI সংকেত |
| Host + ক্লায়েন্ট একসাথে | policy অনুযায়ী queue; কোনো বাক্য কাটে না |
| ২ ক্লায়েন্ট একসাথে | speaker-wise আলাদা, নাম-ট্যাগসহ, সম্পূর্ণ বাক্য |
| বাংলা ভয়েস বাজার সময় host কথা বলে | host-এর কথা হারায় না; ভয়েস queued/stale নীতি |
| ২-৪ ঘণ্টার সেশন | কোনো ম্যানুয়াল হস্তক্ষেপ নয়, memory leak নেই |

---

## 11. সময়রেখা (একজন ডেভেলপার, আনুমানিক)

| ফেজ | সময় | কেন এই ক্রম |
|---|---|---|
| P0 + P6(শুরু) | ৩-৪ দিন | মাপা ছাড়া উন্নতি যাচাই অসম্ভব |
| P1 | ৩-৪ দিন | সবচেয়ে বেশি ব্যথার সমাধান (stop/start, নীরব হারানো) |
| P2 | ৫-৭ দিন | সম্পূর্ণতা |
| P3 | ৫-৭ দিন | Overlap |
| P4 | ৫-৮ দিন | জাপানিজ মান (Cascade সহ) |
| P5 | ১.৫-২.৫ সপ্তাহ | দীর্ঘমেয়াদি স্থিতি, রক্ষণাবেক্ষণ |
| **মোট** | **~৬-৮ সপ্তাহ** | P0+P1 শেষে (~১ সপ্তাহ) দৈনন্দিন ব্যবহারে বড় পার্থক্য আসবে |

**দ্রুত জয় (প্রথম ২ দিনে সম্ভব):** auto-reconnect+heartbeat, `playBuffer` timeout+duck `finally`, auto-retry+placeholder, Meet অডিও duck ২০%, `flushOthers` সরানো।

---

## 12. ঝুঁকি ও প্রশ্ন

| ঝুঁকি | প্রশমন |
|---|---|
| Meet DOM/captions বদলায় | Health check + Whisper fallback + selector config আলাদা ফাইলে |
| OpenAI live API-তে instruction/glossary সমর্থন নেই | Cascade engine (P4.2) |
| Offscreen document-এ mic permission প্রবাহ জটিল | P5.1 আলাদা spike দিয়ে আগে যাচাই; ব্যর্থ হলে SW + পুনঃসংযোগ শক্তিশালী রেখে থামা |
| Retry/merge latency বাড়ায় | সীমা (সর্বোচ্চ অপেক্ষা), feature flag, p95 মাপা |
| বাড়তি call-এর খরচ | Analysis lazy, merge, মডেল স্তরভিত্তিক (ছোট মডেল ডিফল্ট, Precise-এ বড়) |
| জাপানি ক্লায়েন্টের data/privacy আপত্তি | Consent নোটিশ, retention নীতি ডকুমেন্ট, ঐচ্ছিক on-prem/regional provider |

### খোলা প্রশ্ন (উত্তর পেলে প্ল্যান ধারালো হবে)
1. ক্লায়েন্টের কথার উৎস ডিফল্ট কী ব্যবহার করছেন: **Meet captions** নাকি **Whisper live**?
2. Host-এর দিকে ডিফল্ট engine: **OpenAI live** নাকি sentence-by-sentence?
3. "দুইজন একসাথে": প্রধানত **host+ক্লায়েন্ট**, নাকি **একাধিক ক্লায়েন্ট**?
4. Overlap-এ কার অগ্রাধিকার ডিফল্ট হবে: host, ক্লায়েন্ট, নাকি যে আগে শুরু করে?
5. বাজেট: প্রতি মিটিং-ঘণ্টায় সর্বোচ্চ কত খরচ গ্রহণযোগ্য (paid TTS/Cascade ঠিক করতে)?
6. ব্যবহার কি শুধু আপনার লোকাল মেশিনে, নাকি আরও কয়েকজন ব্যবহার করবে (hosted backend/auth দরকার কিনা)?

---

## 13. ফাইল-ভিত্তিক পরিবর্তন মানচিত্র

| ফাইল | মূল পরিবর্তন | ফেজ |
|---|---|---|
| [extension/bridge.js](extension/bridge.js) | Ledger, retry, concurrency limit, auto-reconnect, floor-control UI, health bar | P0-P3 → P5-এ ভাঙা |
| [extension/inject.js](extension/inject.js) | playBuffer timeout, duck finally, epoch, jitter buffer, comfort noise, overlap VAD | P1, P3, P4 |
| [extension/background.js](extension/background.js) | Reconnect/heartbeat/seq-ack, লম্বা টেক্সট ভাঙা | P1, P5 |
| [extension/captions.js](extension/captions.js) | Speaker-wise buffer, `flushOthers` সরানো, health+watchdog | P2 |
| [backend/src/server.ts](backend/src/server.ts) | ping/pong, session resume, auth ticket | P1, P5 |
| [backend/src/services/realtimeTranslate.ts](backend/src/services/realtimeTranslate.ts) | Drop counter, context re-seed, instruction/glossary | P0, P1, P4 |
| [backend/src/services/realtimeTranscribe.ts](backend/src/services/realtimeTranscribe.ts) | `completed` merge fix, জাপানিজ-সচেতন segmentation | P2 |
| [backend/src/services/aiService.ts](backend/src/services/aiService.ts) | Analysis lazy, merge, fallback chain, structured log | P2 |
| `backend/src/services/cascade/*` (নতুন) | Cascade engine | P4 |
| `backend/src/routes/subtitle.ts` (নতুন) | Subtitle লিংক | P4 |
| `tests/` (নতুন) | Golden set, replay, unit, fault-injection | P6 |

---

## 14. পরবর্তী পদক্ষেপ

1. §12-এর খোলা প্রশ্নের উত্তর দিন।
2. **P0 + P1-এর দ্রুত জয়গুলো** দিয়ে শুরু করা হোক (≈১ সপ্তাহ), তারপর P2 → P3।
3. P0 শেষে একটা আসল মিটিংয়ে ledger-রিপোর্ট দেখে বাকি ফেজের অগ্রাধিকার চূড়ান্ত করা।
