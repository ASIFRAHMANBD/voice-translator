// Service worker: the only place that talks to the backend. Running the fetch here
// keeps it outside Meet's page CSP (connect-src) and keeps the API token out of the page.
const DEFAULT_BACKEND_URL = "http://localhost:3000"
const REQUEST_TIMEOUT_MS = 30_000
const SUMMARY_TIMEOUT_MS = 90_000
const MAX_AUDIO_BASE64_LENGTH = 14 * 1024 * 1024
const MAX_CONTEXT_LENGTH = 4000
const MAX_TEXT_LENGTH = 1000
const MAX_SUMMARY_TURNS = 300
const DIRECTIONS = new Set(["outgoing", "incoming"])
const TARGET_LANGS = new Set(["ja", "en"])
const VOICE_LANGS = new Set(["bn", "ja", "en"])

const getSettings = async () => {
  const { backendUrl, apiToken } = await chrome.storage.local.get(["backendUrl", "apiToken"])
  return { backendUrl: backendUrl || DEFAULT_BACKEND_URL, apiToken: apiToken || "" }
}

const base64ToBlob = (base64, mime) => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

const isValidText = (text) => typeof text === "string" && text.trim().length > 0 && text.trim().length <= MAX_TEXT_LENGTH

const isValidVoiceRate = (rate) => rate === undefined || (typeof rate === "number" && Number.isFinite(rate))

const validateVoicePayload = (payload) => {
  if (!payload || typeof payload !== "object") return "Invalid request."
  if (!DIRECTIONS.has(payload.direction)) return "Invalid direction."
  if (!TARGET_LANGS.has(payload.targetLang)) return "Invalid target language."
  if (!isValidVoiceRate(payload.voiceRate)) return "Invalid voice speed."
  if (typeof payload.text === "string") return isValidText(payload.text) ? null : "Text is missing or too long."
  if (typeof payload.audioBase64 !== "string" || payload.audioBase64.length === 0) return "Missing audio."
  if (payload.audioBase64.length > MAX_AUDIO_BASE64_LENGTH) return "Audio clip is too large."
  return null
}

const validateSpeechPayload = (payload) => {
  if (!payload || typeof payload !== "object") return "Invalid request."
  if (!VOICE_LANGS.has(payload.lang)) return "Invalid voice language."
  if (!isValidVoiceRate(payload.voiceRate)) return "Invalid voice speed."
  return isValidText(payload.text) ? null : "Text is missing or too long."
}

const validateSummaryPayload = (payload) => {
  if (!payload || !Array.isArray(payload.turns) || payload.turns.length === 0) return "Nothing to summarize yet."
  if (payload.turns.length > MAX_SUMMARY_TURNS) return "Too many turns to summarize."
  return null
}

const readErrorMessage = async (res) => {
  try {
    const body = await res.json()
    return body.error || `Backend returned ${res.status}`
  } catch {
    return `Backend returned ${res.status}`
  }
}

const postToBackend = async (path, body, timeoutMs, extraHeaders = {}) => {
  const { backendUrl, apiToken } = await getSettings()
  const headers = { ...extraHeaders, ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}) }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await fetch(`${backendUrl}${path}`, { method: "POST", body, headers, signal: controller.signal })
    if (!res.ok) return { ok: false, error: await readErrorMessage(res) }
    return { ok: true, data: await res.json() }
  } catch (err) {
    if (err.name === "AbortError") return { ok: false, error: `Backend took longer than ${timeoutMs / 1000} seconds.` }
    return { ok: false, error: `Can't reach backend at ${backendUrl}. Is it running?` }
  } finally {
    clearTimeout(timer)
  }
}

const postJson = (path, payload, timeoutMs) =>
  postToBackend(path, JSON.stringify(payload), timeoutMs, { "Content-Type": "application/json" })

const processVoice = (payload) => {
  const formData = new FormData()
  if (typeof payload.text === "string") {
    formData.append("text", payload.text.trim())
    if (typeof payload.lang === "string" && payload.lang) {
      formData.append("lang", payload.lang.trim())
    }
  } else {
    const mime = (payload.mime || "audio/webm").split(";")[0]
    const extension = mime.includes("ogg") ? "ogg" : "webm"
    formData.append("audio", base64ToBlob(payload.audioBase64, mime), `chunk.${extension}`)
  }
  formData.append("direction", payload.direction)
  formData.append("target_lang", payload.targetLang)
  formData.append("tts", payload.speak === false ? "off" : "on")
  if (payload.voiceRate !== undefined) formData.append("voice_rate", String(payload.voiceRate))
  if (Array.isArray(payload.context) && payload.context.length > 0) {
    const context = JSON.stringify(payload.context)
    if (context.length <= MAX_CONTEXT_LENGTH) formData.append("context", context)
  }
  return postToBackend("/api/process-voice", formData, REQUEST_TIMEOUT_MS)
}

const synthesize = (payload) =>
  postJson("/api/tts", { text: payload.text.trim(), lang: payload.lang, voice_rate: payload.voiceRate }, REQUEST_TIMEOUT_MS)

const summarize = (payload) => postJson("/api/summary", { turns: payload.turns }, SUMMARY_TIMEOUT_MS)

const HANDLERS = {
  PROCESS_VOICE: { validate: validateVoicePayload, run: processVoice },
  SYNTHESIZE: { validate: validateSpeechPayload, run: synthesize },
  SUMMARIZE: { validate: validateSummaryPayload, run: summarize },
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = HANDLERS[message?.type]
  if (!handler) return false
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith("https://meet.google.com/")) {
    sendResponse({ ok: false, error: "Unauthorized sender." })
    return false
  }
  const invalid = handler.validate(message.payload)
  if (invalid) {
    sendResponse({ ok: false, error: invalid })
    return false
  }
  handler.run(message.payload).then(sendResponse)
  return true
})

// ---------------------------------------------------------------------------
// Live interpreter: the page streams mic audio over a long-lived port, and this
// worker relays it to the backend WebSocket (which holds the OpenAI key).
// ---------------------------------------------------------------------------
// Port name -> backend WebSocket path. translate: your Bangla -> JA/EN voice.
// transcribe: the client's JA/EN speech -> text, translated to Bangla per sentence.
const REALTIME_PORTS = {
  "realtime-translate": { path: "/ws/translate", needsTarget: true },
  "realtime-transcribe": { path: "/ws/transcribe", needsTarget: false },
}
const WS_CONNECT_TIMEOUT_MS = 8_000
const MAX_QUEUED_MESSAGES = 100

const buildRealtimeSocketUrl = (backendUrl, path, targetLang, apiToken) => {
  const url = new URL(`${backendUrl.replace(/\/+$/, "")}${path}`)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  if (targetLang) url.searchParams.set("target", targetLang)
  if (apiToken) url.searchParams.set("token", apiToken)
  return url.toString()
}

const handleRealtimePort = (port, route) => {
  let ws = null
  let started = false
  let opened = false
  let closed = false
  let connectTimer = null
  const queue = []

  const postToPage = (message) => {
    if (closed) return
    try {
      port.postMessage(message)
    } catch {
      // Port already gone.
    }
  }

  const shutdown = (reason, error) => {
    if (closed) return
    if (error) postToPage({ type: "error", message: error, fatal: true })
    postToPage({ type: "closed", reason })
    closed = true
    clearTimeout(connectTimer)
    try {
      ws?.close()
    } catch {
      // ignore
    }
    try {
      port.disconnect()
    } catch {
      // ignore
    }
  }

  const sendToSocket = (message) => {
    if (opened && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message))
      return
    }
    if (queue.length >= MAX_QUEUED_MESSAGES) queue.shift()
    queue.push(message)
  }

  const connect = async (targetLang) => {
    const { backendUrl, apiToken } = await getSettings()
    if (closed) return
    let url
    try {
      url = buildRealtimeSocketUrl(backendUrl, route.path, targetLang, apiToken)
    } catch {
      shutdown("bad_url", `Backend URL is invalid: ${backendUrl}`)
      return
    }
    ws = new WebSocket(url)
    connectTimer = setTimeout(() => {
      if (!opened) shutdown("timeout", `Can't reach the backend at ${backendUrl}. Is it running?`)
    }, WS_CONNECT_TIMEOUT_MS)

    ws.onopen = () => {
      opened = true
      clearTimeout(connectTimer)
      while (queue.length > 0) ws.send(JSON.stringify(queue.shift()))
    }
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return
      try {
        postToPage(JSON.parse(event.data))
      } catch {
        // Ignore malformed frames.
      }
    }
    ws.onerror = () => {
      // onclose follows with the details.
    }
    ws.onclose = (event) => {
      if (!opened) {
        shutdown("unreachable", `Can't reach the live interpreter at ${backendUrl}. Is the backend running and up to date?`)
        return
      }
      shutdown(event.reason || "closed")
    }
  }

  port.onMessage.addListener((message) => {
    if (!message || typeof message !== "object") return
    if (message.type === "start") {
      if (started) return
      started = true
      const targetLang = route.needsTarget ? (TARGET_LANGS.has(message.targetLang) ? message.targetLang : "ja") : ""
      connect(targetLang)
      return
    }
    if (message.type === "audio" && typeof message.audio === "string" && message.audio.length > 0) {
      sendToSocket({ type: "audio", audio: message.audio })
      return
    }
    if (message.type === "stop") sendToSocket({ type: "stop" })
  })

  port.onDisconnect.addListener(() => {
    closed = true
    clearTimeout(connectTimer)
    try {
      ws?.close()
    } catch {
      // ignore
    }
  })
}

chrome.runtime.onConnect.addListener((port) => {
  const route = REALTIME_PORTS[port.name]
  if (!route) return
  const sender = port.sender
  if (sender?.id !== chrome.runtime.id || !sender.url?.startsWith("https://meet.google.com/")) {
    port.disconnect()
    return
  }
  handleRealtimePort(port, route)
})
