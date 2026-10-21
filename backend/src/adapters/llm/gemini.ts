import { requireValue, type AppConfig } from "../../config.js"
import { providerFetch } from "../../lib/http.js"
import type { LlmAdapter } from "../../types.js"
import { buildLlmAdapter } from "./base.js"

type GeminiResponse = { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }

export const createGeminiLlm = (config: AppConfig): LlmAdapter => {
  const apiKey = requireValue(config.gemini.apiKey, "GEMINI_API_KEY", "gemini")
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.gemini.model)}:generateContent`

  return buildLlmAdapter("gemini", async ({ system, user }, { json }) => {
    const res = await providerFetch("gemini", url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { temperature: 0.2, ...(json ? { responseMimeType: "application/json" } : {}) },
      }),
    })
    const data = (await res.json()) as GeminiResponse
    return data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? ""
  })
}
