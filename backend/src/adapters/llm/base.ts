import { ProviderError } from "../../lib/http.js"
import type { LlmAdapter } from "../../types.js"
import { buildAnalysisMessages, buildMessages, buildSummaryMessages, parseTranslateResult } from "./prompt.js"

export type LlmMessages = { system: string; user: string }
// Sends one system + user message pair and returns the raw text reply.
export type LlmComplete = (messages: LlmMessages, options: { json: boolean }) => Promise<string>

export const buildLlmAdapter = (name: string, complete: LlmComplete): LlmAdapter => ({
  name,
  translate: async (input) => {
    const raw = await complete(buildMessages(input), { json: true })
    try {
      return parseTranslateResult(raw)
    } catch (err) {
      throw new ProviderError(name, (err as Error).message)
    }
  },
  analyze: async (input) => {
    const raw = await complete(buildAnalysisMessages(input), { json: false })
    return raw.trim()
  },
  summarize: async (input) => {
    const raw = await complete(buildSummaryMessages(input), { json: false })
    const summary = raw.trim()
    if (!summary) throw new ProviderError(name, "returned an empty summary")
    return summary
  },
})
