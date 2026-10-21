import { bearer, fileNameForMime, providerFetch } from "../../lib/http.js"
import { normalizeLang } from "../../lib/lang.js"
import type { SttAdapter } from "../../types.js"

type OpenAiCompatibleSttOptions = { name: string; baseUrl: string; apiKey: string; model: string }

type WhisperSegment = { text?: string; no_speech_prob?: number; avg_logprob?: number }
type Transcription = {
  text?: string
  // whisper-1 / Groq Whisper (verbose_json)
  language?: string
  segments?: WhisperSegment[]
  // gpt-transcribe family (json)
  languages?: Array<{ code?: string }>
}

// Whisper invents filler ("Thank you.", repeated syllables) on noise-only audio,
// often with confident logprobs, but no_speech_prob stays high (~0.85 vs ~0.05 for speech).
const extractText = (data: Transcription): string => {
  const full = (data.text ?? "").trim()
  if (!full) return ""
  // Only treat as non-speech if Whisper is over 85% certain that EVERY segment is noise/silence
  if (Array.isArray(data.segments) && data.segments.length > 0) {
    const allSilence = data.segments.every((s) => (s.no_speech_prob ?? 0) > 0.85)
    if (allSilence) return ""
  }
  return full
}

const detectedLanguage = (data: Transcription): string =>
  normalizeLang(data.language) || normalizeLang(data.languages?.[0]?.code)

// GPT transcription models (gpt-transcribe, gpt-4o-transcribe, ...) support Bangla
// and only return "json"/"text"; Whisper models need verbose_json for no_speech_prob.
const isGptTranscriber = (model: string): boolean => model.startsWith("gpt-")

// Works for any OpenAI-compatible /audio/transcriptions endpoint
// (OpenAI, Groq, faster-whisper-server/speaches, LocalAI, ...).
export const createOpenAiCompatibleStt = ({ name, baseUrl, apiKey, model }: OpenAiCompatibleSttOptions): SttAdapter => {
  const gpt = isGptTranscriber(model)
  const isOpenAi = baseUrl.includes("api.openai.com")

  return {
    name,
    transcribe: async (audio, mime, { lang, prompt } = {}) => {
      const form = new FormData()
      form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), fileNameForMime(mime))
      form.append("model", model)
      form.append("response_format", gpt ? "json" : "verbose_json")
      // OpenAI's whisper-1 rejects "bn" (HTTP 400); everything else gets the hint,
      // which is what keeps Bangla in Bangla script instead of Hindi/Kannada.
      if (lang && !(isOpenAi && !gpt && lang === "bn")) form.append("language", lang)
      // Only real context (glossary + the speaker's previous sentence). A fixed
      // sample sentence here gets echoed back by Whisper on quiet audio.
      if (prompt) form.append("prompt", prompt)

      const res = await providerFetch(name, `${baseUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
        method: "POST",
        headers: bearer(apiKey),
        body: form,
      })
      const data = (await res.json()) as Transcription
      return { text: extractText(data), lang: detectedLanguage(data) || lang || "" }
    },
  }
}
