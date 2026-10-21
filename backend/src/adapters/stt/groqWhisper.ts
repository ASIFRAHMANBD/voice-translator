import { requireValue, type AppConfig } from "../../config.js"
import type { SttAdapter } from "../../types.js"
import { createOpenAiCompatibleStt } from "./openaiWhisper.js"

export const createGroqStt = (config: AppConfig): SttAdapter =>
  createOpenAiCompatibleStt({
    name: "groq-whisper",
    baseUrl: config.groq.baseUrl,
    apiKey: requireValue(config.groq.apiKey, "GROQ_API_KEY", "groq"),
    model: config.groq.sttModel,
  })
