import { config } from "../config.js"
import { createSttAdapter } from "../adapters/stt/index.js"
import { createLlmAdapter } from "../adapters/llm/index.js"
import { createTtsAdapter } from "../adapters/tts/index.js"
import { buildDemoResponse } from "../demo/demoResponse.js"
import { guessLangFromText, normalizeLang } from "../lib/lang.js"
import { splitForSpeech } from "../lib/sentences.js"
import type {
  LlmAdapter,
  ProcessVoiceRequest,
  ProcessVoiceResponse,
  SttAdapter,
  SummaryTurn,
  TtsAdapter,
  TtsResult,
  Voice,
} from "../types.js"

const DEMO_SUMMARY = "বাংলা\nসারাংশ\n• (ডেমো মোড) আসল সারাংশ পেতে DEMO_MODE=false করুন।\n\nEnglish\nSummary\n• (Demo mode) Set DEMO_MODE=false for a real summary."

type Adapters = { stt: SttAdapter; llm: LlmAdapter; tts: TtsAdapter }

const BANGLA = "bn"
const STT_PROMPT_PART_MAX_CHARS = 200

// Whisper's prompt biases spelling and script: the glossary keeps names right,
// and the same speaker's previous sentence keeps the style consistent.
const buildSttPrompt = ({ direction, context }: ProcessVoiceRequest): string => {
  const speaker = direction === "outgoing" ? "host" : "client"
  const previous = [...context].reverse().find((turn) => turn.speaker === speaker)?.text ?? ""
  return [config.sttGlossary.slice(0, STT_PROMPT_PART_MAX_CHARS), previous.slice(-STT_PROMPT_PART_MAX_CHARS)]
    .filter(Boolean)
    .join(" ")
}

const timed = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
  const startedAt = performance.now()
  const result = await fn()
  return [result, Math.round(performance.now() - startedAt)]
}

// Built once at startup so a bad provider name or missing key fails fast.
const adapters: Adapters | null = config.demoMode
  ? null
  : { stt: createSttAdapter(config), llm: createLlmAdapter(config), tts: createTtsAdapter(config) }

export const describeProviders = () =>
  adapters
    ? { mode: "live", stt: adapters.stt.name, llm: adapters.llm.name, tts: adapters.tts.name }
    : { mode: "demo" }

export const processVoice = async (request: ProcessVoiceRequest): Promise<ProcessVoiceResponse> => {
  if (!adapters) return buildDemoResponse(request.direction, request.targetLang)

  const totalStart = performance.now()
  const isOutgoing = request.direction === "outgoing"

  const { input } = request
  const [stt, sttMs] =
    input.kind === "text"
      ? [{ text: input.text, lang: isOutgoing ? BANGLA : (input.lang || "") }, 0]
      : await timed(() =>
          adapters.stt.transcribe(input.audio, input.mime, {
            lang: isOutgoing ? BANGLA : undefined,
            prompt: buildSttPrompt(request),
          })
        )
  const transcript = stt.text.trim()
  const detectedLang = isOutgoing ? BANGLA : normalizeLang(stt.lang) || guessLangFromText(transcript)

  if (!transcript) {
    return {
      transcript: "",
      detected_lang: detectedLang,
      translated_text: "",
      understood: "",
      analysis: "",
      audio_base64: "",
      audio_mime: "",
      remaining_sentences: [],
      voice_lang: "",
      empty: true,
      unclear: false,
      voice_error: "",
      timings: { stt_ms: sttMs, llm_ms: 0, tts_ms: 0, total_ms: Math.round(performance.now() - totalStart) },
    }
  }

  const targetLang = isOutgoing ? request.targetLang : BANGLA
  const translateInput = {
    direction: request.direction,
    text: transcript,
    sourceLang: detectedLang,
    targetLang,
    context: request.context,
    glossary: config.sttGlossary,
  }
  // The reply analysis is a separate call running in parallel, so the Bangla
  // translation and its voice don't wait for it.
  const analysisPromise = isOutgoing
    ? Promise.resolve("")
    : adapters.llm.analyze(translateInput).catch((err) => {
        console.warn(`Analysis failed: ${err instanceof Error ? err.message : err}`)
        return ""
      })
  const [translation, llmMs] = await timed(() => adapters.llm.translate(translateInput))

  // Only the first sentence is voiced here so playback starts sooner; the client
  // fetches the rest from /api/tts while it plays.
  const [firstSentence, ...remainingSentences] = request.speak
    ? splitForSpeech(translation.translated_text, targetLang)
    : []
  const shouldSpeak = Boolean(firstSentence)
  const ttsStart = performance.now()
  let speech: TtsResult | null = null
  let voiceError = ""
  if (shouldSpeak) {
    try {
      speech = await adapters.tts.synthesize(firstSentence, targetLang, { rate: request.voiceRate, voice: request.voice })
    } catch (err) {
      // The text is still useful to the host even when no voice could be made.
      voiceError = err instanceof Error ? err.message : "voice generation failed"
      console.error(`TTS failed: ${voiceError}`)
    }
  }
  const ttsMs = shouldSpeak ? Math.round(performance.now() - ttsStart) : 0
  const analysis = translation.unclear ? "" : await analysisPromise

  return {
    transcript,
    detected_lang: detectedLang,
    translated_text: translation.translated_text,
    understood: translation.understood,
    analysis,
    audio_base64: speech ? speech.audio.toString("base64") : "",
    audio_mime: speech ? speech.mime : "",
    remaining_sentences: speech ? remainingSentences : [],
    voice_lang: targetLang,
    empty: !translation.unclear && !translation.translated_text,
    unclear: translation.unclear,
    voice_error: voiceError,
    timings: {
      stt_ms: sttMs,
      llm_ms: llmMs,
      tts_ms: ttsMs,
      total_ms: Math.round(performance.now() - totalStart),
    },
  }
}

export class DemoModeError extends Error {}

export const synthesizeSpeech = async (text: string, lang: string, rate: number, voice: Voice): Promise<TtsResult> => {
  if (!adapters) throw new DemoModeError("Speech synthesis is not available in demo mode")
  return adapters.tts.synthesize(text, lang, { rate, voice })
}

export const summarizeMeeting = async (turns: SummaryTurn[]): Promise<string> => {
  if (!adapters) return DEMO_SUMMARY
  return adapters.llm.summarize({ turns, glossary: config.sttGlossary })
}
