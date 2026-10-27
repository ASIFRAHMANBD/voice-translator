import { requireValue, type AppConfig } from "../../config.js"
import { createChatCompletionLlm } from "./openaiCompatible.js"

// DeepInfra serves an OpenAI-compatible /chat/completions endpoint.
export const createDeepInfraLlm = (config: AppConfig) =>
  createChatCompletionLlm({
    name: "deepinfra",
    baseUrl: requireValue(config.deepinfra.baseUrl, "DEEPINFRA_BASE_URL", "deepinfra"),
    apiKey: requireValue(config.deepinfra.apiKey, "DEEPINFRA_API_KEY", "deepinfra"),
    model: requireValue(config.deepinfra.llmModel, "DEEPINFRA_LLM_MODEL", "deepinfra"),
    jsonMode: true,
  })
