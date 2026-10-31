# Deployment History — Meet AI Interpreter

Live backend: `https://translate.cloudproductionltd.com` → `194.163.132.177`
Repo: `git@github.com:ASIFRAHMANBD/voice-translator.git` (public)

Last updated: 2026-11-01 01:23 +06

---

## Current production state

| Item | Value |
| --- | --- |
| Server | `root@194.163.132.177` (Ubuntu 24.04.4 LTS, x86_64) |
| DNS | `translate.cloudproductionltd.com` → `194.163.132.177` (A record) |
| TLS | Let's Encrypt, `/etc/letsencrypt/live/translate.cloudproductionltd.com/` |
| Container | `meet-ai-interpreter` → `asif449/meet-ai-interpreter-backend:0.3` |
| Container created | 2026-10-31T19:22:48Z · running · restarts=0 |
| Publish | `127.0.0.1:8084` → container `3000` (not exposed publicly) |
| Reverse proxy | nginx → `proxy_pass http://127.0.0.1:8084` |
| Deploy directory | `/opt/meet-ai-interpreter/` (`docker-compose.yml`, `.env` mode 600) |
| Docker / Compose | Docker 29.5.2, Compose v5.1.4 |
| Disk / RAM | 36 GB free, 11 GB RAM |

### Live endpoints

| Endpoint | Purpose | Auth |
| --- | --- | --- |
| `GET /health` | Liveness + provider report | none |
| `POST /api/process-voice` | STT → LLM → TTS pipeline | `API_TOKEN` if set |
| `POST /api/tts` | Text → speech | `API_TOKEN` if set |
| `POST /api/summary` | Meeting summary | `API_TOKEN` if set |
| `WS /ws/translate` | Live interpreter (host Bangla → JA/EN) | `?token=` query param |
| `WS /ws/transcribe` | Live client transcription (JA/EN → Bangla) | `?token=` query param |

`/health` response as of 2026-11-01:

```json
{"ok":true,
 "providers":{"mode":"live","stt":"deepinfra-whisper","llm":"deepinfra","tts":"edge-tts>google-translate>openai-tts"},
 "live":{"available":true,"model":"gpt-realtime-translate","transcription":"gpt-realtime-whisper"}}
```

### nginx site (`/etc/nginx/sites-enabled/translate.cloudproductionltd.com`)

```nginx
server {
    server_name translate.cloudproductionltd.com;
    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:8084;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
        proxy_buffering off;
    }

    listen [::]:443 ssl; # managed by Certbot
    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/translate.cloudproductionltd.com/fullchain.pem; # managed by Certbot
    ssl_certificate_key /etc/letsencrypt/live/translate.cloudproductionltd.com/privkey.pem; # managed by Certbot
    include /etc/letsencrypt/options-ssl-nginx.conf; # managed by Certbot
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem; # managed by Certbot
}
# port 80 -> 301 https, managed by Certbot
```

WebSocket upgrade is handled by the `Upgrade`/`Connection` headers above; the 86400 s
read timeout keeps long-lived interpreter sockets alive.

---

## Image releases

| Tag | Built | Digest / Image ID | Notes |
| --- | --- | --- | --- |
| `0.1` | 2026-10-28 18:21 CEST | `1dfde9655b3b` | First deploy. Already contained the `isDevanagari` script fix. |
| `0.2` | 2026-10-31 17:55 CEST | `1ed9e2c8429d` | Multi-arch manifest index `sha256:1ed9e2c8429db588793dec2e29b06ff7605721e49c0aa115269185f8a6c0c20a`, amd64 manifest `sha256:ba44cc2877a12f7fd32525af1b7778257d8ddf742ec50e422794c64a2a8eb0c9`. |
| `0.3` | 2026-11-01 01:21 +06 | `35a1128a56ba` | Current. Clause-boundary & idle-flush streaming TTS, parallel synthesis with FIFO ordering, 600-frame zero-drop buffer (`sha256:35a1128a56baf3d63a070ffe4a0615a4bc3`, amd64 `sha256:d76be8a97f14b33d17ec73eb6c19b0584aaa4826`). |

Both are pushed to Docker Hub as `asif449/meet-ai-interpreter-backend` (public read).

Image size on Docker Hub: ~50 MB compressed / 205 MB uncompressed.

---

## Deployment timeline

### 2026-10-21 → 2026-10-27 — local development

Extension and backend built and iterated on the `production` branch.

| Commit | Date | What |
| --- | --- | --- |
| `4115314` | 2026-10-21 21:24 | Initial commit: two-way live voice interpreter (BN ↔ JA/EN) |
| `298136f` | 2026-10-21 23:10 | Fix incoming JA→Bangla pipeline: missing events, `getMeetAudioElements`, pending count leak |
| `fe03e38` | 2026-10-21 23:55 | Mute client original voice during incoming translation (no double audio) |
| `87f8ac6` | 2026-10-23 11:16 | Reliability upgrade: auto-reconnect, retry pipeline, audio ducking |
| `3a35148` | 2026-10-24 20:08 | Voice change option |
| `466386d` | 2026-10-25 21:57 | Merge `feature/voice-change` → `main` |
| `8324abb` | 2026-10-27 16:37 | Meeting board, one-click stop, per-speaker attribution |
| `b4ae8f4` | 2026-10-27 16:38 | Extension version → 1.4.0 |
| `ad00d99` | 2026-10-27 17:59 | Show the real reason when live sessions fail (replaced the generic reconnect loop) |
| `1373ba8` | 2026-10-27 17:59 | Extension version → 1.4.1 |
| `b2be345` | 2026-10-27 19:14 | Add DeepInfra as an LLM and speech-to-text provider |

### 2026-10-28 18:21 — release `0.1`

First deployment of the backend to the production server.

- `docker-compose.yml` pinned `asif449/meet-ai-interpreter-backend:0.1`
- Container bound to `127.0.0.1:8084`, nginx proxied to it
- TLS issued via Certbot for `translate.cloudproductionltd.com`
- `ALLOWED_ORIGINS` and `API_TOKEN` left empty (open access)

### 2026-10-28 — extension pointed at localhost

The extension shipped pointed at `http://localhost:3000`:

- `extension/background.js` → `DEFAULT_BACKEND_URL = "http://localhost:3000"`
- `extension/bridge.js` → same constant
- `extension/manifest.json` → `host_permissions` had only `meet.google.com`, `localhost:3000`, `127.0.0.1:3000`

No production URL existed anywhere in the repo or in git history.

### 2026-10-28 → 2026-10-30 — diagnosis of the "reconnecting" loop

Symptom: starting a conversation printed `connection lost. Reconnecting (try N)…` forever.

Two separate causes:

1. **Local backend was dead.** The `tsx watch` watcher process was alive but had no
   child server process; nothing was listening on port 3000. `fetch("http://localhost:3000/health")`
   failed. Machine uptime was 4 days (no reboot), no node crash reports. Fixed by
   killing the stale watcher and starting a fresh `npm run dev`.
2. **The retry message hid the real error.** `background.js` → `ws.onclose` →
   `shutdown("unreachable", …, retryable)` → page `handleRealtimeDrop` →
   `scheduleLiveReconnect` (10 attempts, backoff `[500,1000,2000,4000,8000] ms`).
   The good message from `background.js` was overwritten by the generic loop text.
   Patched `extension/bridge.js` so the real reason is shown and retained.

### 2026-10-31 17:55 — release `0.2`

Built and pushed a multi-arch image for the AMD64 server, then rolled it out.

```bash
docker buildx build --builder cpl-builder --platform linux/amd64 \
  -t asif449/meet-ai-interpreter-backend:0.2 --push -f Dockerfile .
```

On the server:

```bash
cd /opt/meet-ai-interpreter
cp docker-compose.yml docker-compose.yml.bak
sed -i 's|:0.1|:0.2|' docker-compose.yml
docker compose pull && docker compose up -d --force-recreate
```

Note: the first `docker compose pull && up -d` still pulled `0.1` because compose
had the old tag pinned — the tag edit above is what actually rolled the container.

Verified after the roll: container on `:0.2`, clean logs, `GET /health` → `ok:true`,
`wss://translate.cloudproductionltd.com/ws/translate` upgraded successfully through nginx.

### 2026-10-31 — extension repointed at production

| File | Change |
| --- | --- |
| `extension/background.js:3` | `DEFAULT_BACKEND_URL` → `https://translate.cloudproductionltd.com` |
| `extension/bridge.js:37` | same constant |
| `extension/manifest.json` | version `1.4.1` → `1.5.0`; added `https://translate.cloudproductionltd.com/*` to `host_permissions` |

> **Regression caught:** the `host_permissions` entry was lost at some point between
> the edit and the release. Without it Chrome blocks the connection for every user.
> It is present in the current file and in the shipped zip — re-check it after any
> manifest edit.

### 2026-11-01 00:05 — extension packaged

`meet-ai-interpreter-extension-1.5.0.zip` (45 KB) built at the repo root:

```
extension/background.js
extension/bridge.js
extension/captions.js
extension/hud.css
extension/inject.js
extension/manifest.json
```

Built with `zip -r -X … -x '*.DS_Store'`. Ships the `1.5.0` manifest including the
production host permission.

### 2026-11-01 00:49 — this document written

### 2026-11-01 01:23 — release `0.3` & extension rebuild

Built and pushed `asif449/meet-ai-interpreter-backend:0.3` (`linux/amd64` via `cpl-builder`) with clause-boundary TTS synthesis, parallel FIFO TTS pipeline, and 600-frame zero-drop buffering, then rolled it out on `194.163.132.177` (`/opt/meet-ai-interpreter/docker-compose.yml`). Also rebuilt `meet-ai-interpreter-extension-1.5.0.zip` with the Web Audio `GainNode` ducking fix, 100 ms streaming frames, and dual-pane transcript board.

---

## Reproducing a deployment

### Build and push the image (on an Apple Silicon Mac)

The server is AMD64, so the image must be cross-built.

```bash
cd backend
docker buildx build --builder cpl-builder --platform linux/amd64 \
  -t asif449/meet-ai-interpreter-backend:<TAG> --push -f Dockerfile .
```

Check the local builder supports the platform:

```bash
docker buildx ls    # builder must list linux/amd64
```

### Roll it out on the server

```bash
ssh root@194.163.132.177
cd /opt/meet-ai-interpreter
cp docker-compose.yml docker-compose.yml.bak
sed -i 's|:0\.[0-9]*|:<TAG>|' docker-compose.yml
docker compose pull
docker compose up -d --force-recreate
docker logs --tail 30 meet-ai-interpreter
curl -s https://translate.cloudproductionltd.com/health
```

### Rebuild the extension zip

```bash
cd /Users/asif/Documents/project/CPL/voice-chrome-extention
rm -f meet-ai-interpreter-extension-*.zip
zip -r -X meet-ai-interpreter-extension-<VERSION>.zip extension -x '*.DS_Store'
```

### Install for a user

1. Unzip → an `extension/` folder
2. `chrome://extensions` → **Developer mode** ON
3. **Load unpacked** → select the `extension/` folder
4. Open Google Meet → HUD appears at the bottom right
5. Settings → **Backend URL** = `https://translate.cloudproductionltd.com` (pre-filled)

---

## Known issues and open work

| Issue | Status |
| --- | --- |
| OpenAI account has no credit (`insufficient_quota`, `credit_balance_exhausted`) | Open — user is adding credit. Until then the OpenAI live interpreter and `gpt-transcribe` both fail. |
| No `API_TOKEN` / `ALLOWED_ORIGINS` on the server | Open — any web page can POST to the public endpoint and spend the account's credits. Setting a token means every user must paste it into HUD Settings → API token. |
| Bangla STT via DeepInfra `openai/whisper-large-v3` | Returns an **English translation** of Bangla, not Bangla. Forced `language=bn` returns an empty string. `nvidia/Nemotron-3.5-ASR-Streaming-Multilingual-0.6b` transcribes Bangla correctly but writes it in Devanagari (Hindi) script, which the LLM layer already repairs via the `understood` field. OpenAI `gpt-transcribe` handles Bangla properly once credit exists. |
| Extension has no `icons/` and no `action` in the manifest | Open — cosmetic only; Chrome uses a default puzzle-piece icon. |
| Extension install is "Load unpacked" only | Open — no Chrome Web Store listing yet, so each user installs manually from the zip. |
| Backend image tags are not pinned by digest | Open — compose pins a mutable tag (`0.2`). |

---

## Uncommitted working tree (as of 2026-11-01)

```
 M extension/background.js      2 +-   backend URL → production
 M extension/bridge.js          6 ++-  reconnect reason + backend URL → production
 M extension/manifest.json      3 ++-  version 1.5.0 + production host permission
?? .puku/                       Puku editor plans
?? backend/.dockerignore        Docker build context exclusions
?? backend/Dockerfile            two-stage node:20-alpine build
?? meet-ai-interpreter-extension-1.5.0.zip
```

Not committed and not pushed to GitHub.

---

## Server environment (`/opt/meet-ai-interpreter/.env`, mode 600)

Keys present on the server — values are never stored in this repo or in this file.

```
PORT, HOST, DEMO_MODE, API_TOKEN, ALLOWED_ORIGINS, MAX_UPLOAD_MB, PROVIDER_TIMEOUT_MS
STT_PROVIDER, LLM_PROVIDER, TTS_PROVIDER, TTS_FALLBACK_PROVIDER
TTS_PROVIDER_BN, TTS_PROVIDER_JA, TTS_PROVIDER_EN, STT_GLOSSARY
OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_STT_MODEL, OPENAI_LLM_MODEL, OPENAI_TTS_MODEL,
  OPENAI_TTS_VOICE, OPENAI_TTS_INSTRUCTIONS
OPENAI_REALTIME_TRANSLATE_MODEL, OPENAI_REALTIME_TRANSCRIBE_MODEL, OPENAI_REALTIME_NOISE_REDUCTION
DEEPINFRA_API_KEY, DEEPINFRA_BASE_URL, DEEPINFRA_LLM_MODEL, DEEPINFRA_STT_MODEL
GROQ_API_KEY, GROQ_BASE_URL, GROQ_STT_MODEL
DEEPGRAM_API_KEY, DEEPGRAM_MODEL
GEMINI_API_KEY, GEMINI_MODEL
ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL
EDGE_TTS_VOICE_BN, EDGE_TTS_VOICE_JA, EDGE_TTS_VOICE_EN
CUSTOM_STT_URL, CUSTOM_STT_KEY, CUSTOM_LLM_URL, CUSTOM_LLM_KEY, CUSTOM_LLM_MODEL,
  CUSTOM_LLM_JSON_MODE, CUSTOM_LLM_REASONING_EFFORT, CUSTOM_TTS_URL, CUSTOM_TTS_KEY
```

Active provider selection on the server:

```
STT_PROVIDER=deepinfra
LLM_PROVIDER=deepinfra
TTS_PROVIDER=edge
TTS_FALLBACK_PROVIDER=google-translate
DEEPINFRA_STT_MODEL=openai/whisper-large-v3
DEEPINFRA_LLM_MODEL=google/gemma-4-31B-it
```

---

## Repository history (all branches)

```
b2be345  2026-10-27 19:14  feat: add DeepInfra as an LLM and speech-to-text provider
1373ba8  2026-10-27 17:59  chore: bump extension version to 1.4.1
ad00d99  2026-10-27 17:59  fix: show the real reason when the live sessions fail
b4ae8f4  2026-10-27 16:38  chore: bump extension version to 1.4.0
8324abb  2026-10-27 16:37  feat: meeting board, one-click stop, and per-speaker attribution
466386d  2026-10-25 21:57  Merge pull request #1 from feature/voice-change
3a35148  2026-10-24 20:08  feat: added voice change option
87f8ac6  2026-10-23 11:16  feat: upgrade reliability, auto-reconnect, retry pipeline, and audio ducking
fe03e38  2026-10-21 23:55  Mute client original voice during incoming translation to prevent double audio
298136f  2026-10-21 23:10  fix: incoming Japanese→Bangla pipeline — missing events, getMeetAudioElements, pending count leak
4115314  2026-10-21 21:24  Initial commit: Meet AI two-way live voice interpreter (BN <-> JA/EN)
```

Branches: `main`, `production` (current), `feature/voice-change`.
No git tags have been created — release tracking lives in this file and in the Docker Hub tags.
