import { requireValue, type AppConfig } from "../../config.js"
import type { SttAdapter } from "../../types.js"
import { createCustomHttpStt } from "./customHttp.js"
import { createDeepgramStt } from "./deepgram.js"
import { createGroqStt } from "./groqWhisper.js"
import { createOpenAiCompatibleStt } from "./openaiWhisper.js"

const factories: Record<string, (config: AppConfig) => SttAdapter> = {
  openai: (config) =>
    createOpenAiCompatibleStt({
      name: "openai-whisper",
      baseUrl: config.openai.baseUrl,
      apiKey: requireValue(config.openai.apiKey, "OPENAI_API_KEY", "openai"),
      model: config.openai.sttModel,
    }),
  groq: createGroqStt,
  deepgram: createDeepgramStt,
  custom: createCustomHttpStt,
}

export const createSttAdapter = (config: AppConfig): SttAdapter => {
  const factory = factories[config.sttProvider]
  if (!factory) {
    throw new Error(`Unknown STT_PROVIDER "${config.sttProvider}". Use one of: ${Object.keys(factories).join(", ")}`)
  }
  return factory(config)
}
