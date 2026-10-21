import { requireValue, type AppConfig } from "../../config.js"
import type { LlmAdapter } from "../../types.js"
import { createChatCompletionLlm } from "./openaiCompatible.js"

export const createOpenAiLlm = (config: AppConfig): LlmAdapter =>
  createChatCompletionLlm({
    name: "openai",
    baseUrl: config.openai.baseUrl,
    apiKey: requireValue(config.openai.apiKey, "OPENAI_API_KEY", "openai"),
    model: config.openai.llmModel,
    jsonMode: true,
  })
