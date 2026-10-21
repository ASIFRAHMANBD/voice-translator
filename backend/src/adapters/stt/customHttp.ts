import { requireValue, type AppConfig } from "../../config.js"
import { bearer, fileNameForMime, providerFetch } from "../../lib/http.js"
import { normalizeLang } from "../../lib/lang.js"
import type { SttAdapter } from "../../types.js"

type CustomSttResponse = { text?: string; transcript?: string; lang?: string; language?: string }

// Contract: POST multipart { audio, language?, prompt? } -> JSON { text, lang }
export const createCustomHttpStt = (config: AppConfig): SttAdapter => {
  const url = requireValue(config.custom.sttUrl, "CUSTOM_STT_URL", "custom")

  return {
    name: "custom-stt",
    transcribe: async (audio, mime, { lang, prompt } = {}) => {
      const form = new FormData()
      form.append("audio", new Blob([new Uint8Array(audio)], { type: mime }), fileNameForMime(mime))
      if (lang) form.append("language", lang)
      if (prompt) form.append("prompt", prompt)

      const res = await providerFetch("custom-stt", url, {
        method: "POST",
        headers: bearer(config.custom.sttKey),
        body: form,
      })
      const data = (await res.json()) as CustomSttResponse
      return {
        text: data.text ?? data.transcript ?? "",
        lang: normalizeLang(data.lang ?? data.language) || lang || "",
      }
    },
  }
}
