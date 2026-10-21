import { requireValue, type AppConfig } from "../../config.js"
import { bearer, providerFetch } from "../../lib/http.js"
import type { LlmAdapter } from "../../types.js"
import { buildLlmAdapter } from "./base.js"

type ChatCompletionOptions = {
  name: string
  baseUrl: string
  apiKey: string
  model: string
  jsonMode: boolean
  reasoningEffort?: string
}

type ChatCompletionResponse = { choices?: Array<{ message?: { content?: string } }> }

const REASONING_EFFORTS = new Set(["low", "medium", "high"])

// Any /chat/completions server: OpenAI, vLLM (Qwen/Llama), Groq, Ollama, LM Studio, ...
export const createChatCompletionLlm = ({
  name,
  baseUrl,
  apiKey,
  model,
  jsonMode,
  reasoningEffort,
}: ChatCompletionOptions): LlmAdapter =>
  buildLlmAdapter(name, async ({ system, user }, { json }) => {
    const res = await providerFetch(name, `${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...bearer(apiKey) },
      body: JSON.stringify({
        model,
        temperature: json ? 0 : 0.3,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        ...(json && jsonMode ? { response_format: { type: "json_object" } } : {}),
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      }),
    })
    const data = (await res.json()) as ChatCompletionResponse
    return data.choices?.[0]?.message?.content ?? ""
  })

export const createOpenAiCompatibleLlm = (config: AppConfig): LlmAdapter => {
  const effort = config.custom.llmReasoningEffort
  if (effort && !REASONING_EFFORTS.has(effort)) {
    throw new Error(`CUSTOM_LLM_REASONING_EFFORT must be low, medium or high, got "${effort}"`)
  }
  return createChatCompletionLlm({
    name: "openai-compatible",
    baseUrl: requireValue(config.custom.llmUrl, "CUSTOM_LLM_URL", "openai-compatible"),
    apiKey: config.custom.llmKey,
    model: requireValue(config.custom.llmModel, "CUSTOM_LLM_MODEL", "openai-compatible"),
    jsonMode: config.custom.llmJsonMode,
    reasoningEffort: effort || undefined,
  })
}
