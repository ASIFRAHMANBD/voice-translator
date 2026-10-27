import { requireValue, type AppConfig } from "../../config.js"
import { createOpenAiCompatibleStt } from "./openaiWhisper.js"

// DeepInfra hosts Whisper behind an OpenAI-compatible /audio/transcriptions
// endpoint, so the same adapter handles it.
export const createDeepInfraStt = (config: AppConfig) =>
  createOpenAiCompatibleStt({
    name: "deepinfra-whisper",
    baseUrl: requireValue(config.deepinfra.baseUrl, "DEEPINFRA_BASE_URL", "deepinfra"),
    apiKey: requireValue(config.deepinfra.apiKey, "DEEPINFRA_API_KEY", "deepinfra"),
    model: requireValue(config.deepinfra.sttModel, "DEEPINFRA_STT_MODEL", "deepinfra"),
  })
