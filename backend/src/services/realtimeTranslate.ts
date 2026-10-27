import WebSocket, { type RawData } from "ws"
import { config } from "../config.js"
import { isFatalUpstreamError } from "../lib/upstreamErrors.js"
import { createTtsAdapter } from "../adapters/tts/index.js"
import type { Voice } from "../types.js"

// One live interpretation session: the extension streams the host's microphone
// (24 kHz PCM16, ~200 ms frames) and gets back translated speech and both
// transcripts as they are produced, while the host is still talking.
//
// Extension -> backend: { type: "audio", audio: base64 } | { type: "stop" }
// Backend -> extension: ready | status | source_delta | translation_delta | audio | error | closed

const MAX_AUDIO_BASE64 = 256 * 1024
// Audio kept while connecting or reconnecting, so the first words aren't lost (~10 s).
const MAX_QUEUED_FRAMES = 50
const MAX_RECONNECTS = 5
// After "stop", wait this long for the last translated words before giving up.
const DRAIN_TIMEOUT_MS = 8_000
// The service pads its output with silence after session.close; don't relay that.
const SILENCE_PEAK = 300
// The service speaks in chunks that break mid-word, so text is collected until a
// sentence ends before it is synthesized in the chosen voice.
const SENTENCE_END = /[。．.!?！？]\s*$/u
const MIN_SYNTH_CHARS = 2

type Outgoing =
  | { type: "ready" }
  | { type: "status"; state: "reconnecting" | "connected" }
  | { type: "source_delta"; delta: string }
  | { type: "translation_delta"; delta: string }
  | { type: "audio"; audio: string; sampleRate: number }
  // Our own TTS audio, used when a specific voice is selected.
  | { type: "synth"; audio: string; mime: string }
  | { type: "error"; message: string; fatal: boolean }
  | { type: "closed"; reason: string }

type UpstreamEvent = {
  type?: string
  delta?: string
  sample_rate?: number
  session?: { audio?: { output?: { language?: string } } }
  error?: { message?: string; code?: string | null }
}

const isSilent = (pcm: Buffer): boolean => {
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    if (Math.abs(pcm.readInt16LE(i)) > SILENCE_PEAK) return false
  }
  return true
}

// The realtime translations endpoint has no voice parameter: session.audio.output
// only takes "language", and the service picks its own output voice. A chosen
// voice is therefore applied by our own TTS adapter (see below), not here.
const buildSessionUpdate = (targetLang: string) => {
  const { transcribeModel, noiseReduction } = config.realtime
  return {
    type: "session.update",
    session: {
      audio: {
        input: {
          // Note: translation sessions reject a transcription "language" field.
          transcription: transcribeModel ? { model: transcribeModel } : null,
          noise_reduction: noiseReduction === "none" ? null : { type: noiseReduction },
        },
        output: { language: targetLang },
      },
    },
  }
}

const isAuthFailure = (message: string): boolean => /\b(401|403|404)\b/.test(message)

export const handleTranslateClient = (client: WebSocket, targetLang: string, initialVoice: Voice = "default"): void => {
  const startedAt = Date.now()
  let upstream: WebSocket | null = null
  let ready = false
  let everReady = false
  let stopping = false
  let finished = false
  let reconnects = 0
  let lastUpstreamError = ""
  let drainTimer: NodeJS.Timeout | null = null
  const queue: string[] = []
  const transcript = { source: "", translation: "" }

  // The translations service has no voice parameter, so a chosen voice is applied
  // here instead: the service's own audio is dropped and the translated text is
  // spoken by our TTS adapter in the requested voice. "default" keeps the
  // service's audio, which is lower latency.
  // The voice can change while the session runs, so it is not a constant.
  let useOwnVoice = initialVoice !== "default" && !config.demoMode
  let voice: Voice = initialVoice
  let tts = useOwnVoice ? createTtsAdapter(config) : null
  let synthText = ""
  let synthBusy = false
  const synthQueue: string[] = []

  const send = (message: Outgoing) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message))
  }

  const appendAudio = (audio: string) => {
    upstream?.send(JSON.stringify({ type: "session.input_audio_buffer.append", audio }))
  }

  const upstreamOpen = () => upstream?.readyState === WebSocket.OPEN

  const flushQueue = () => {
    while (queue.length > 0 && ready && upstreamOpen()) appendAudio(queue.shift() as string)
  }

  // Speaks queued sentences one at a time, so the order and the gaps stay right.
  const drainSynthQueue = async () => {
    if (synthBusy || !tts) return
    synthBusy = true
    try {
      while (synthQueue.length > 0) {
        const text = synthQueue.shift() as string
        if (!text.trim()) continue
        try {
          const speech = await tts.synthesize(text, targetLang, { rate: 1, voice })
          // The extension plays MP3 through the normal PLAY path.
          send({ type: "synth", audio: speech.audio.toString("base64"), mime: speech.mime })
          console.info(`[live ${targetLang}] spoke: ${text}`)
        } catch (err) {
          const message = err instanceof Error ? err.message : err
          console.warn(`[live ${targetLang}] voice synthesis failed: ${message}`)
          // No voice at all is worse than the wrong voice, so the service's own
          // audio is used from here on.
          send({ type: "error", message: `Could not speak with the ${voice} voice (${message}). Using the service voice instead.`, fatal: false })
          useOwnVoice = false
          synthText = ""
          synthQueue.length = 0
        }
      }
    } finally {
      synthBusy = false
    }
  }

  // The service emits text in pieces that break mid-sentence, so a piece is only
  // spoken once a sentence ends (or the text grows past a usable length).
  const collectForSpeech = (delta: string) => {
    synthText += delta
    if (!SENTENCE_END.test(synthText) && synthText.length < 120) return
    const text = synthText.trim()
    synthText = ""
    if (text.length < MIN_SYNTH_CHARS) return
    synthQueue.push(text)
    void drainSynthQueue()
  }

  // The last words often have no closing punctuation, so they are spoken too.
  const flushSpeech = () => {
    if (!useOwnVoice || !synthText.trim()) return
    const text = synthText.trim()
    synthText = ""
    if (text.length < MIN_SYNTH_CHARS) return
    synthQueue.push(text)
    void drainSynthQueue()
  }

  // The dropdown can change the voice while the session runs. Switching to
  // "default" hands the audio back to the service; the other way round drops it.
  const setVoice = (next: Voice) => {
    if (next === voice) return
    voice = next
    useOwnVoice = voice !== "default" && !config.demoMode
    if (useOwnVoice && !tts) tts = createTtsAdapter(config)
    // Half-collected text is kept: it is spoken in the new voice, so no words
    // are lost at the switch.
    console.info(`[live ${targetLang}] voice changed to ${voice}`)
  }

  const finish = (reason: string) => {
    if (finished) return
    finished = true
    if (drainTimer) clearTimeout(drainTimer)
    const seconds = Math.round((Date.now() - startedAt) / 1000)
    console.info(`[live ${targetLang}] ended (${reason}) after ${seconds}s`)
    if (transcript.source) console.info(`[live ${targetLang}] heard: ${transcript.source.slice(-300)}`)
    if (transcript.translation) console.info(`[live ${targetLang}] said:  ${transcript.translation.slice(-300)}`)
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

  // The last sentence is still being synthesized when the service closes, so the
  // client is held open until the queue is empty. Otherwise that audio is lost.
  const finishAfterSpeech = (reason: string) => {
    flushSpeech()
    if (!synthBusy && synthQueue.length === 0) {
      finish(reason)
      return
    }
    const wait = setInterval(() => {
      if (finished) return
      if (synthBusy || synthQueue.length > 0) return
      clearInterval(wait)
      finish(reason)
    }, 100)
    const limit = setTimeout(() => {
      clearInterval(wait)
      finish(reason)
    }, DRAIN_TIMEOUT_MS)
    wait.unref?.()
    limit.unref?.()
  }

  // Flushes pending input on the service side and lets it finish the last words.
  const requestClose = () => {
    flushQueue()
    flushSpeech()
    upstream?.send(JSON.stringify({ type: "session.close" }))
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
        // A rejected update leaves the default output language (Spanish) in place.
        const language = event.session?.audio?.output?.language
        if (language !== targetLang) {
          fail(`Live interpreter started with the wrong language (${language ?? "none"}).`)
          return
        }
        ready = true
        reconnects = 0
        send(everReady ? { type: "status", state: "connected" } : { type: "ready" })
        everReady = true
        if (stopping) requestClose()
        else flushQueue()
        return
      }
      case "session.input_transcript.delta":
        if (event.delta) {
          transcript.source += event.delta
          send({ type: "source_delta", delta: event.delta })
        }
        return
      case "session.output_transcript.delta":
        if (event.delta) {
          transcript.translation += event.delta
          send({ type: "translation_delta", delta: event.delta })
          if (useOwnVoice) collectForSpeech(event.delta)
        }
        return
      case "session.output_audio.delta":
        if (!event.delta) return
        // With our own voice the service's audio is dropped: it would play the
        // wrong (default) voice over the synthesized one.
        if (useOwnVoice) return
        if (stopping && isSilent(Buffer.from(event.delta, "base64"))) return
        send({ type: "audio", audio: event.delta, sampleRate: event.sample_rate ?? 24_000 })
        return
      case "session.closed":
        finishAfterSpeech(stopping ? "stopped" : "closed by service")
        return
      case "error": {
        const message = event.error?.message || "Live interpreter error"
        console.warn(`[live ${targetLang}] service error: ${message}`)
        // Before the session is configured, an error means our settings were rejected.
        // A quota or credential problem will not fix itself on a retry either, so
        // it must end the session instead of reconnecting in a loop.
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
    const url = `${config.realtime.url}?model=${encodeURIComponent(config.realtime.model)}`
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${config.openai.apiKey}` } })
    upstream = ws

    ws.on("open", () => ws.send(JSON.stringify(buildSessionUpdate(targetLang))))
    ws.on("message", handleUpstreamMessage)
    ws.on("error", (err) => {
      lastUpstreamError = err.message
      console.warn(`[live ${targetLang}] connection error: ${err.message}`)
    })
    ws.on("close", () => {
      if (upstream !== ws || finished) return
      ready = false
      if (stopping) {
        finishAfterSpeech("stopped")
        return
      }
      if (isAuthFailure(lastUpstreamError)) {
        fail(`OpenAI refused the live interpreter (${lastUpstreamError}). Check OPENAI_API_KEY and model access.`)
        return
      }
      if (reconnects >= MAX_RECONNECTS) {
        fail("Lost the connection to the OpenAI live interpreter.")
        return
      }
      // Sessions also end when they expire; reconnect and keep going.
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
    if (ready && upstreamOpen()) requestClose()
    else if (!upstream || upstream.readyState === WebSocket.CLOSED) finishAfterSpeech("stopped")
    // Otherwise the session is still connecting; session.updated sends the close.
    drainTimer = setTimeout(() => finishAfterSpeech("drain timeout"), DRAIN_TIMEOUT_MS)
  }

  client.on("message", (raw) => {
    let message: { type?: string; audio?: unknown; voice?: unknown }
    try {
      message = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (message.type === "stop") {
      stop()
      return
    }
    if (message.type === "voice") {
      const next = String(message.voice ?? "")
      if (next === "male" || next === "female" || next === "default") setVoice(next)
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
    // The extension went away (tab closed, stopped); end the paid session too.
    if (!stopping) stop()
  })
  client.on("error", () => {})

  console.info(`[live ${targetLang}] session starting (${config.realtime.model}), voice=${voice}`)
  connect()
}
