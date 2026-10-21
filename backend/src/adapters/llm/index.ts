import type { AppConfig } from "../../config.js"
import type { LlmAdapter } from "../../types.js"
import { createGeminiLlm } from "./gemini.js"
import { createOpenAiLlm } from "./openai.js"
import { createOpenAiCompatibleLlm } from "./openaiCompatible.js"

const factories: Record<string, (config: AppConfig) => LlmAdapter> = {
  openai: createOpenAiLlm,
  gemini: createGeminiLlm,
  "openai-compatible": createOpenAiCompatibleLlm,
  vllm: createOpenAiCompatibleLlm,
  custom: createOpenAiCompatibleLlm,
}

export const createLlmAdapter = (config: AppConfig): LlmAdapter => {
  const factory = factories[config.llmProvider]
  if (!factory) {
    throw new Error(`Unknown LLM_PROVIDER "${config.llmProvider}". Use one of: ${Object.keys(factories).join(", ")}`)
  }
  return factory(config)
}
