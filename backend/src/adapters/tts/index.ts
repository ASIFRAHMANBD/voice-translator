import type { AppConfig } from "../../config.js"
import { ProviderError } from "../../lib/http.js"
import type { TtsAdapter } from "../../types.js"
import { createCustomHttpTts } from "./customHttp.js"
import { createEdgeTts } from "./edgeTts.js"
import { createElevenLabsTts } from "./elevenlabs.js"
import { createGoogleTranslateTts } from "./googleTranslate.js"
import { createOpenAiTts } from "./openai.js"

// After a rate limit, skip the primary voice for a while: retrying immediately
// only extends the block.
const RATE_LIMIT_COOLDOWN_MS = 60_000

const factories: Record<string, (config: AppConfig) => TtsAdapter> = {
  openai: createOpenAiTts,
  elevenlabs: createElevenLabsTts,
  edge: createEdgeTts,
  "edge-tts": createEdgeTts,
  "google-translate": createGoogleTranslateTts,
  custom: createCustomHttpTts,
}

const buildAdapter = (provider: string, envKey: string, config: AppConfig): TtsAdapter => {
  const factory = factories[provider]
  if (!factory) {
    throw new Error(`Unknown ${envKey} "${provider}". Use one of: ${Object.keys(factories).join(", ")}`)
  }
  return factory(config)
}

const isRateLimited = (err: unknown) =>
  err instanceof ProviderError && (err.status === 429 || /\b429\b/.test(err.message))

const withFallback = (primary: TtsAdapter, fallback: TtsAdapter): TtsAdapter => {
  let cooldownUntil = 0
  return {
    name: `${primary.name}>${fallback.name}`,
    synthesize: async (text, lang, options) => {
      if (Date.now() < cooldownUntil) return fallback.synthesize(text, lang, options)
      try {
        return await primary.synthesize(text, lang, options)
      } catch (err) {
        if (isRateLimited(err)) cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS
        console.warn(`TTS ${primary.name} failed, using ${fallback.name}: ${err instanceof Error ? err.message : err}`)
        return fallback.synthesize(text, lang, options)
      }
    },
  }
}

export const createTtsAdapter = (config: AppConfig): TtsAdapter => {
  const instances = new Map<string, TtsAdapter>()
  const getInstance = (provider: string, envKey: string) => {
    const existing = instances.get(provider)
    if (existing) return existing
    const adapter = buildAdapter(provider, envKey, config)
    instances.set(provider, adapter)
    return adapter
  }

  const backupProvider = config.ttsFallbackProvider
  const backup = backupProvider && backupProvider !== "none" ? getInstance(backupProvider, "TTS_FALLBACK_PROVIDER") : null
  const wrapped = new Map<TtsAdapter, TtsAdapter>()
  const protect = (adapter: TtsAdapter) => {
    if (!backup || adapter === backup) return adapter
    const existing = wrapped.get(adapter)
    if (existing) return existing
    const guarded = withFallback(adapter, backup)
    wrapped.set(adapter, guarded)
    return guarded
  }

  const defaultAdapter = protect(getInstance(config.ttsProvider, "TTS_PROVIDER"))
  const byLang = new Map<string, TtsAdapter>()
  Object.entries(config.ttsProviderByLang).forEach(([lang, provider]) => {
    if (provider) byLang.set(lang, protect(getInstance(provider, `TTS_PROVIDER_${lang.toUpperCase()}`)))
  })
  if (byLang.size === 0) return defaultAdapter

  const pick = (lang: string) => byLang.get(lang) ?? defaultAdapter
  const summary = ["bn", "ja", "en"].map((lang) => `${lang}:${pick(lang).name}`).join(",")

  return {
    name: summary,
    synthesize: (text, lang, options) => pick(lang).synthesize(text, lang, options),
  }
}
