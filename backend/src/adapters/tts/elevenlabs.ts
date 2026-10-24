import { requireValue, type AppConfig } from "../../config.js"
import { providerFetch } from "../../lib/http.js"
import type { TtsAdapter, Voice } from "../../types.js"

export const createElevenLabsTts = (config: AppConfig): TtsAdapter => {
  const apiKey = requireValue(config.elevenlabs.apiKey, "ELEVENLABS_API_KEY", "elevenlabs")
  const voiceId = requireValue(config.elevenlabs.voiceId, "ELEVENLABS_VOICE_ID", "elevenlabs")

  // The voice id is part of the URL, so it is chosen per request. "default" keeps
  // the provider's own voice.
  const pickVoiceId = (voice: Voice): string => {
    if (voice === "male") return config.elevenlabs.voiceIds.male || voiceId
    if (voice === "female") return config.elevenlabs.voiceIds.female || voiceId
    return voiceId
  }

  return {
    name: "elevenlabs",
    supportsGender: true,
    synthesize: async (text, lang, { rate = 1, voice = "default" } = {}) => {
      const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(pickVoiceId(voice))}?output_format=mp3_44100_128`
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
