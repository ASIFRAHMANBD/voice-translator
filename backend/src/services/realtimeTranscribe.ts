import WebSocket, { type RawData } from "ws"
import { config } from "../config.js"
import { guessLangFromText } from "../lib/lang.js"
import { isFatalUpstreamError } from "../lib/upstreamErrors.js"

// Live transcription of the client's speech (meeting audio). The client may switch
// between Japanese and English at any time, so no language is fixed: the model
// detects it per word. Text arrives word by word; this service cuts it into
// sentences, and the extension translates each sentence into Bangla.
//
// Extension -> backend: { type: "audio", audio: base64 } | { type: "stop" }
// Backend -> extension: ready | status | interim { text } | segment { text, lang } | error | closed

const MAX_AUDIO_BASE64 = 256 * 1024
// Keep up to ~10 seconds of audio frames during upstream reconnects (each frame ≈ 200ms of 24kHz PCM).
const MAX_QUEUED_FRAMES = 300
const MAX_RECONNECTS = 5
// A finished sentence ("?", "。", ". ") is sent after this short wait, so a very
// short one ("OK.") can still merge with the next.
const SENTENCE_SETTLE_MS = 250
// No new words for this long means the client paused: send what we have.
const PAUSE_AFTER_SENTENCE_MS = 400
const PAUSE_MID_SENTENCE_MS = 800
const ENDS_SENTENCE = /[。！？!?.][」』）)"]?\s*$/u
// After "stop", keep collecting the last words for this long after the last one arrives.
const DRAIN_QUIET_MS = 1_500
const DRAIN_MAX_MS = 5_000
// Long unpunctuated speech is cut at a comma or space after this many characters.
const MAX_SEGMENT_CHARS = 260
const MIN_SENTENCE_CHARS = 3
const MIN_SENTENCE_CHARS_CJK = 2
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u
// "." ends a sentence at end of utterance or before whitespace ("3.5" survives).
const SENTENCE_END = /[。！？!?]+[」』）)"]?|\.(?=\s|$)/gu
const ABBREVIATION = /\b(?:mr|mrs|ms|dr|prof|st|vs|etc|inc|ltd|co|jr|sr|no|e\.g|i\.e)$/i
const SOFT_BREAK = /[、，,;；]\s*|\s+/gu

type Outgoing =
  | { type: "ready" }
  | { type: "status"; state: "reconnecting" | "connected" }
  | { type: "interim"; text: string }
  | { type: "segment"; text: string; lang: string }
  | { type: "error"; message: string; fatal: boolean }
  | { type: "closed"; reason: string }

type UpstreamEvent = {
  type?: string
  delta?: string
  transcript?: string
  session?: { audio?: { input?: { transcription?: { model?: string } | null } } }
  error?: { message?: string }
}

const hasWords = (text: string): boolean => /[\p{Letter}\p{Number}]/u.test(text)

const isLongEnough = (text: string): boolean => {
  const letters = text.replace(/[^\p{Letter}\p{Number}]/gu, "").length
  return letters >= (CJK.test(text) ? MIN_SENTENCE_CHARS_CJK : MIN_SENTENCE_CHARS)
}

// End offset of the last finished sentence that is long enough to send alone, or 0.
const lastSentenceEnd = (text: string): number => {
  let end = 0
  for (const match of text.matchAll(SENTENCE_END)) {
    const index = match.index ?? 0
    if (match[0] === "." && ABBREVIATION.test(text.slice(0, index))) continue
    const candidate = index + match[0].length
    if (isLongEnough(text.slice(0, candidate))) end = candidate
  }
  return end
}

// Where to cut long unpunctuated speech: the last comma or space before the limit.
const softBreakEnd = (text: string): number => {
  let end = 0
  for (const match of text.matchAll(SOFT_BREAK)) {
    const candidate = (match.index ?? 0) + match[0].length
    if (candidate > MAX_SEGMENT_CHARS) break
    end = candidate
  }
  return end || MAX_SEGMENT_CHARS
}

const buildSessionUpdate = () => {
  const { transcribeModel } = config.realtime
  return {
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24_000 },
          // No language: the client switches between Japanese and English.
          transcription: { model: transcribeModel },
          // Meet has already cleaned up remote audio; more processing only hurts.
          noise_reduction: null,
          // gpt-realtime-whisper is a continuous streaming model: it transcribes
          // word-by-word and explicitly rejects turn_detection. Leave it null.
          // Flushing is handled by our pause timers and the completed event.
          turn_detection: null,
        },
      },
    },
  }
}

const isAuthFailure = (message: string): boolean => /\b(401|403|404)\b/.test(message)

export const handleTranscribeClient = (client: WebSocket): void => {
  const startedAt = Date.now()
  const model = config.realtime.transcribeModel
  let upstream: WebSocket | null = null
  let ready = false
  let everReady = false
  let stopping = false
  let finished = false
  let reconnects = 0
  let lastUpstreamError = ""
  let buffer = ""
  let segments = 0
  let sentenceTimer: NodeJS.Timeout | null = null
  let pauseTimer: NodeJS.Timeout | null = null
  let drainTimer: NodeJS.Timeout | null = null
  let drainMaxTimer: NodeJS.Timeout | null = null
  const queue: string[] = []

  const send = (message: Outgoing) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message))
  }

  const sendInterim = () => send({ type: "interim", text: buffer.trim() })

  const emit = (text: string) => {
    const clean = text.trim()
    if (!hasWords(clean)) return
    segments += 1
    const lang = guessLangFromText(clean)
    console.info(`[client ${lang || "?"}] ${clean}`)
    send({ type: "segment", text: clean, lang })
  }

  const clearSegmentTimers = () => {
    if (sentenceTimer) clearTimeout(sentenceTimer)
    if (pauseTimer) clearTimeout(pauseTimer)
    sentenceTimer = null
    pauseTimer = null
  }

  const flushAll = () => {
    clearSegmentTimers()
    const text = buffer
    buffer = ""
    emit(text)
    sendInterim()
  }

  const flushSentences = () => {
    sentenceTimer = null
    const end = lastSentenceEnd(buffer)
    if (end === 0) return
    const text = buffer.slice(0, end)
    buffer = buffer.slice(end).replace(/^\s+/, "")
    emit(text)
    sendInterim()
  }

  const handleDelta = (delta: string) => {
    buffer += delta
    // Long speech without punctuation: send the first part instead of waiting.
    while (buffer.length > MAX_SEGMENT_CHARS && lastSentenceEnd(buffer) === 0) {
      const end = softBreakEnd(buffer)
      emit(buffer.slice(0, end))
      buffer = buffer.slice(end).replace(/^\s+/, "")
    }
    sendInterim()

    if (sentenceTimer) clearTimeout(sentenceTimer)
    sentenceTimer = lastSentenceEnd(buffer) > 0 ? setTimeout(flushSentences, SENTENCE_SETTLE_MS) : null
    if (pauseTimer) clearTimeout(pauseTimer)
    pauseTimer = setTimeout(flushAll, ENDS_SENTENCE.test(buffer) ? PAUSE_AFTER_SENTENCE_MS : PAUSE_MID_SENTENCE_MS)

    if (stopping) {
      if (drainTimer) clearTimeout(drainTimer)
      drainTimer = setTimeout(() => finish("stopped"), DRAIN_QUIET_MS)
    }
  }

  const appendAudio = (audio: string) => {
    upstream?.send(JSON.stringify({ type: "input_audio_buffer.append", audio }))
  }

  const upstreamOpen = () => upstream?.readyState === WebSocket.OPEN

  const flushQueue = () => {
    while (queue.length > 0 && ready && upstreamOpen()) appendAudio(queue.shift() as string)
  }

  const finish = (reason: string) => {
    if (finished) return
    finished = true
    if (drainTimer) clearTimeout(drainTimer)
    if (drainMaxTimer) clearTimeout(drainMaxTimer)
    flushAll()
    const seconds = Math.round((Date.now() - startedAt) / 1000)
    console.info(`[client transcription] ended (${reason}) after ${seconds}s, ${segments} sentences`)
    send({ type: "closed", reason })
    if (upstream) {
      upstream.removeAllListeners()
      upstream.on("error", () => {})
      upstream.close()
    }
    if (client.readyState === WebSocket.OPEN) client.close(1000)
  }

  const fail = (message: string) => {
    send({ type: "error", message, fatal: true })
    finish("error")
  }

  const handleUpstreamMessage = (raw: RawData) => {
    let event: UpstreamEvent
    try {
      event = JSON.parse(raw.toString()) as UpstreamEvent
    } catch {
      return
    }

    switch (event.type) {
      case "session.updated": {
        const configured = event.session?.audio?.input?.transcription?.model
        if (configured !== model) {
          fail(`Client transcription started without the ${model} model.`)
          return
        }
        ready = true
        reconnects = 0
        send(everReady ? { type: "status", state: "connected" } : { type: "ready" })
        everReady = true
        flushQueue()
        return
      }
      case "conversation.item.input_audio_transcription.delta":
        if (event.delta) handleDelta(event.delta)
        return
      // The completed event carries the finalized transcript for the whole turn.
      // If our buffer still holds partial text (e.g. the delta stream lagged),
      // merge it so not a single word is lost.
      case "conversation.item.input_audio_transcription.completed": {
        const finalText = event.transcript ?? ""
        if (finalText.trim()) {
          clearSegmentTimers()
          // Replace buffer with the authoritative final text if it is longer,
          // otherwise keep what we already have (delta stream was ahead).
          if (finalText.trim().length > buffer.trim().length) {
            buffer = finalText.trim()
          }
          flushAll()
        }
        return
      }
      // Speech-stopped is not fired by gpt-realtime-whisper (turn_detection is null),
      // but handle it defensively in case of model updates.
      case "input_audio_buffer.speech_stopped":
        if (buffer.trim() && pauseTimer) {
          clearTimeout(pauseTimer)
          pauseTimer = setTimeout(flushAll, 200)
        }
        return
      case "error": {
        const message = event.error?.message || "Client transcription error"
        console.warn(`[client transcription] service error: ${message}`)
        // A quota or credential problem will not fix itself on a retry, so it
        // must end the session instead of reconnecting in a loop.
        if (!ready || isFatalUpstreamError(message)) fail(message)
        else send({ type: "error", message, fatal: false })
        return
      }
      default:
        return
    }
  }

  const connect = () => {
    ready = false
    const url = "wss://api.openai.com/v1/realtime?intent=transcription"
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${config.openai.apiKey}` } })
    upstream = ws

    ws.on("open", () => ws.send(JSON.stringify(buildSessionUpdate())))
    ws.on("message", handleUpstreamMessage)
    ws.on("error", (err) => {
      lastUpstreamError = err.message
      console.warn(`[client transcription] connection error: ${err.message}`)
    })
    ws.on("close", () => {
      if (upstream !== ws || finished) return
      ready = false
      if (stopping) {
        finish("stopped")
        return
      }
      if (isAuthFailure(lastUpstreamError)) {
        fail(`OpenAI refused live transcription (${lastUpstreamError}). Check OPENAI_API_KEY and model access.`)
        return
      }
      if (reconnects >= MAX_RECONNECTS) {
        fail("Lost the connection to OpenAI live transcription.")
        return
      }
      // Sessions also end when they expire; keep what was heard and reconnect.
      flushAll()
      reconnects += 1
      send({ type: "status", state: "reconnecting" })
      setTimeout(() => {
        if (!finished) connect()
      }, Math.min(4_000, 400 * reconnects))
    })
  }

  const stop = () => {
    if (stopping || finished) return
    stopping = true
    if (!ready) {
      finish("stopped")
      return
    }
    flushQueue()
    // The last words arrive shortly after the audio ends; wait for them.
    drainTimer = setTimeout(() => finish("stopped"), DRAIN_QUIET_MS)
    drainMaxTimer = setTimeout(() => finish("drain timeout"), DRAIN_MAX_MS)
  }

  client.on("message", (raw) => {
    let message: { type?: string; audio?: unknown }
    try {
      message = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (message.type === "stop") {
      stop()
      return
    }
    if (message.type !== "audio" || stopping) return
    const audio = message.audio
    if (typeof audio !== "string" || audio.length === 0 || audio.length > MAX_AUDIO_BASE64) return
    if (ready && upstreamOpen()) {
      appendAudio(audio)
      return
    }
    queue.push(audio)
    if (queue.length > MAX_QUEUED_FRAMES) queue.shift()
  })

  client.on("close", () => {
    if (!finished) finish("client closed")
  })
  client.on("error", () => {})

  console.info(`[client transcription] session starting (${model})`)
  connect()
}
