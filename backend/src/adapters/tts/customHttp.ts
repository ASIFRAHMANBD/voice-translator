import { requireValue, type AppConfig } from "../../config.js"
import { bearer, ProviderError, providerFetch } from "../../lib/http.js"
import type { TtsAdapter } from "../../types.js"

type CustomTtsJson = { audio_base64?: string; mime?: string }

// Contract: POST JSON { text, lang, rate } -> raw audio bytes (audio/* content type)
// or JSON { audio_base64, mime }. rate: 1 = normal speed.
export const createCustomHttpTts = (config: AppConfig): TtsAdapter => {
  const url = requireValue(config.custom.ttsUrl, "CUSTOM_TTS_URL", "custom")

  return {
    name: "custom-tts",
    synthesize: async (text, lang, { rate = 1 } = {}) => {
      const res = await providerFetch("custom-tts", url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...bearer(config.custom.ttsKey) },
        body: JSON.stringify({ text, lang, rate }),
      })
      const contentType = res.headers.get("content-type") ?? ""

      if (contentType.startsWith("audio/")) {
        return { audio: Buffer.from(await res.arrayBuffer()), mime: contentType.split(";")[0] }
      }

      const data = (await res.json()) as CustomTtsJson
      if (!data.audio_base64) throw new ProviderError("custom-tts", "response had no audio")
      return { audio: Buffer.from(data.audio_base64, "base64"), mime: data.mime ?? "audio/mpeg" }
    },
  }
}
