import { requireValue, type AppConfig } from "../../config.js"
import { bearer, providerFetch } from "../../lib/http.js"
import type { TtsAdapter } from "../../types.js"

export const createOpenAiTts = (config: AppConfig): TtsAdapter => {
  const apiKey = requireValue(config.openai.apiKey, "OPENAI_API_KEY", "openai")
  const url = `${config.openai.baseUrl.replace(/\/+$/, "")}/audio/speech`
  // Only the gpt-4o TTS models accept tone instructions; tts-1 rejects the field.
  const supportsInstructions = config.openai.ttsModel.startsWith("gpt-4o")
  const instructions = supportsInstructions && config.openai.ttsInstructions ? { instructions: config.openai.ttsInstructions } : {}

  return {
    name: "openai-tts",
    synthesize: async (text, _lang, { rate = 1 } = {}) => {
      const res = await providerFetch("openai-tts", url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...bearer(apiKey) },
        body: JSON.stringify({
          model: config.openai.ttsModel,
          voice: config.openai.ttsVoice,
          input: text,
          response_format: "mp3",
          speed: rate,
          ...instructions,
        }),
      })
      return { audio: Buffer.from(await res.arrayBuffer()), mime: "audio/mpeg" }
    },
  }
}
