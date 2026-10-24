import type { AppConfig } from "../../config.js"
import { ProviderError } from "../../lib/http.js"
import type { TtsAdapter, TtsOptions } from "../../types.js"
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

// A provider without a voice parameter cannot honour a male/female request, so
// it must not silently replace the chosen voice.
const canHonour = (adapter: TtsAdapter, options?: TtsOptions): boolean => {
  if (!options?.voice || options.voice === "default") return true
  return adapter.supportsGender !== false
}

// Tries each provider in turn until one works. Providers that cannot deliver
// the requested gender are skipped, so a male/female request is never answered
// with the wrong voice.
const withChain = (primary: TtsAdapter, backups: TtsAdapter[]): TtsAdapter => {
  let cooldownUntil = 0
  return {
    name: [primary, ...backups].map((adapter) => adapter.name).join(">"),
    synthesize: async (text, lang, options) => {
      const chain = [primary, ...backups].filter((adapter) => canHonour(adapter, options))
      let lastError: unknown = new ProviderError(primary.name, "no provider could speak this text")
      for (const adapter of chain) {
        // After a rate limit the provider is skipped for a while.
        if (adapter === primary && Date.now() < cooldownUntil) continue
        try {
          const result = await adapter.synthesize(text, lang, options)
          if (adapter !== primary) {
            console.warn(`TTS ${primary.name} failed, using ${adapter.name}`)
          }
          return result
        } catch (err) {
          if (adapter === primary && isRateLimited(err)) {
            cooldownUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS
          }
          lastError = err
        }
      }
      const skipped = [primary, ...backups].filter((adapter) => !canHonour(adapter, options))
      if (skipped.length > 0) {
        console.warn(
          `TTS ${primary.name} failed and ${skipped.map((a) => a.name).join(", ")} cannot honour the "${
            options?.voice
          }" voice`
        )
      }
      throw lastError instanceof ProviderError
        ? lastError
        : new ProviderError(primary.name, lastError instanceof Error ? lastError.message : "synthesis failed")
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
  // A provider that can actually speak the requested gender, used when the
  // primary one fails: the configured backup often has no voice parameter, and
  // silently using it would drop the chosen voice.
  const genderBackup =
    backup && backup.supportsGender === false && config.openai.apiKey
      ? getInstance("openai", "TTS_PROVIDER")
      : null

  const wrapped = new Map<TtsAdapter, TtsAdapter>()
  const protect = (adapter: TtsAdapter) => {
    if (!backup || adapter === backup) return adapter
    const existing = wrapped.get(adapter)
    if (existing) return existing
    const chain = genderBackup && genderBackup !== adapter ? [backup, genderBackup] : [backup]
    const guarded = withChain(adapter, chain)
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
