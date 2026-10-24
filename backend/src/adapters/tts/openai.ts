import { requireValue, type AppConfig } from "../../config.js"
import { bearer, providerFetch } from "../../lib/http.js"
import type { TtsAdapter, Voice } from "../../types.js"

// The voice names alone are not enough on every model: tts-1's "onyx" and
// "shimmer" sound alike. Naming the gender in the instructions makes the
// difference obvious.
const GENDER_INSTRUCTIONS: Record<Exclude<Voice, "default">, string> = {
  male: "Speak with a clearly male voice: an adult man with a deeper, steady voice.",
  female: "Speak with a clearly female voice: an adult woman with a brighter, warmer voice.",
}

export const createOpenAiTts = (config: AppConfig): TtsAdapter => {
  const apiKey = requireValue(config.openai.apiKey, "OPENAI_API_KEY", "openai")
  const url = `${config.openai.baseUrl.replace(/\/+$/, "")}/audio/speech`
  // Only the gpt-4o TTS models accept tone instructions; tts-1 rejects the field.
  const supportsInstructions = config.openai.ttsModel.startsWith("gpt-4o")

  // "default" keeps the provider's own voice.
  const pickVoice = (voice: Voice): string => {
    if (voice === "male") return config.openai.ttsVoices.male
    if (voice === "female") return config.openai.ttsVoices.female
    return config.openai.ttsVoice
  }

  const buildInstructions = (voice: Voice): { instructions?: string } => {
    if (!supportsInstructions) return {}
    const gender = voice === "male" || voice === "female" ? GENDER_INSTRUCTIONS[voice] : ""
    const base = config.openai.ttsInstructions
    if (!base && !gender) return {}
    return { instructions: [base, gender].filter(Boolean).join(" ") }
  }

  return {
    name: "openai-tts",
    supportsGender: true,
    synthesize: async (text, _lang, { rate = 1, voice = "default" } = {}) => {
      const res = await providerFetch("openai-tts", url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...bearer(apiKey) },
        body: JSON.stringify({
          model: config.openai.ttsModel,
          voice: pickVoice(voice),
          input: text,
          response_format: "mp3",
          speed: rate,
          ...buildInstructions(voice),
        }),
      })
      return { audio: Buffer.from(await res.arrayBuffer()), mime: "audio/mpeg" }
    },
  }
}
