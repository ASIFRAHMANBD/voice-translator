import { requireValue, type AppConfig } from "../../config.js"
import { providerFetch } from "../../lib/http.js"
import type { TtsAdapter } from "../../types.js"

export const createElevenLabsTts = (config: AppConfig): TtsAdapter => {
  const apiKey = requireValue(config.elevenlabs.apiKey, "ELEVENLABS_API_KEY", "elevenlabs")
  const voiceId = requireValue(config.elevenlabs.voiceId, "ELEVENLABS_VOICE_ID", "elevenlabs")
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`

  return {
    name: "elevenlabs",
    synthesize: async (text, lang, { rate = 1 } = {}) => {
      const res = await providerFetch("elevenlabs", url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "xi-api-key": apiKey, Accept: "audio/mpeg" },
        body: JSON.stringify({
          text,
          model_id: config.elevenlabs.model,
          language_code: lang,
          // ElevenLabs accepts speed 0.7-1.2.
          ...(rate !== 1 ? { voice_settings: { speed: Math.min(1.2, Math.max(0.7, rate)) } } : {}),
        }),
      })
      return { audio: Buffer.from(await res.arrayBuffer()), mime: "audio/mpeg" }
    },
  }
}
