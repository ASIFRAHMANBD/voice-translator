import { requireValue, type AppConfig } from "../../config.js"
import { providerFetch } from "../../lib/http.js"
import { normalizeLang } from "../../lib/lang.js"
import type { SttAdapter } from "../../types.js"

type DeepgramResponse = {
  results?: {
    channels?: Array<{
      detected_language?: string
      alternatives?: Array<{ transcript?: string }>
    }>
  }
}

export const createDeepgramStt = (config: AppConfig): SttAdapter => {
  const apiKey = requireValue(config.deepgram.apiKey, "DEEPGRAM_API_KEY", "deepgram")

  return {
    name: "deepgram",
    transcribe: async (audio, mime, { lang } = {}) => {
      const params = new URLSearchParams({ model: config.deepgram.model, smart_format: "true" })
      if (lang) params.set("language", lang)
      else params.set("detect_language", "true")

      const res = await providerFetch("deepgram", `https://api.deepgram.com/v1/listen?${params}`, {
        method: "POST",
        headers: { Authorization: `Token ${apiKey}`, "Content-Type": mime },
        body: new Uint8Array(audio),
      })
      const data = (await res.json()) as DeepgramResponse
      const channel = data.results?.channels?.[0]
      return {
        text: channel?.alternatives?.[0]?.transcript ?? "",
        lang: normalizeLang(channel?.detected_language) || lang || "",
      }
    },
  }
}
