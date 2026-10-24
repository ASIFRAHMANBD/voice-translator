import dotenv from "dotenv"

// backend/.env wins over variables already set in the shell, so a stale global
// OPENAI_API_KEY (or similar) can't silently replace the project's keys.
dotenv.config({ override: true })

const readString = (key: string, fallback = ""): string => (process.env[key] ?? fallback).trim()

const readNumber = (key: string, fallback: number): number => {
  const raw = process.env[key]
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`${key} must be a number, got "${raw}"`)
  return value
}

const readBool = (key: string, fallback: boolean): boolean => {
  const raw = process.env[key]
  if (raw === undefined || raw === "") return fallback
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase())
}

const readList = (key: string): string[] =>
  readString(key)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)

export const config = {
  port: readNumber("PORT", 3000),
  host: readString("HOST", "127.0.0.1"),
  demoMode: readBool("DEMO_MODE", false),
  apiToken: readString("API_TOKEN"),
  allowedOrigins: readList("ALLOWED_ORIGINS"),
  maxUploadBytes: readNumber("MAX_UPLOAD_MB", 10) * 1024 * 1024,
  providerTimeoutMs: readNumber("PROVIDER_TIMEOUT_MS", 25_000),

  sttProvider: readString("STT_PROVIDER", "openai").toLowerCase(),
  llmProvider: readString("LLM_PROVIDER", "openai").toLowerCase(),
  ttsProvider: readString("TTS_PROVIDER", "edge").toLowerCase(),
  // Used when the chosen voice fails (e.g. Edge rate limiting); "none" disables it.
  ttsFallbackProvider: readString("TTS_FALLBACK_PROVIDER", "google-translate").toLowerCase(),
  // Optional per-language override, e.g. a paid voice for the client, free Edge for Bangla.
  ttsProviderByLang: {
    bn: readString("TTS_PROVIDER_BN").toLowerCase(),
    ja: readString("TTS_PROVIDER_JA").toLowerCase(),
    en: readString("TTS_PROVIDER_EN").toLowerCase(),
  } as Record<string, string>,
  // Names and terms Whisper should spell correctly (company, product, people).
  sttGlossary: readString("STT_GLOSSARY"),

  openai: {
    apiKey: readString("OPENAI_API_KEY"),
    baseUrl: readString("OPENAI_BASE_URL", "https://api.openai.com/v1"),
    // whisper-1 rejects Bangla ("bn") and garbles it without the hint; gpt-transcribe handles it.
    sttModel: readString("OPENAI_STT_MODEL", "gpt-transcribe"),
    llmModel: readString("OPENAI_LLM_MODEL", "gpt-4.1-mini"),
    ttsModel: readString("OPENAI_TTS_MODEL", "gpt-4o-mini-tts"),
    ttsVoice: readString("OPENAI_TTS_VOICE", "ash"),
    // Gender voices. gpt-4o-mini-tts has clearly distinct ones; onyx reads
    // male, coral reads female.
    ttsVoices: {
      male: readString("OPENAI_TTS_VOICE_MALE", "onyx"),
      female: readString("OPENAI_TTS_VOICE_FEMALE", "coral"),
    } as Record<string, string>,
    ttsInstructions: readString(
      "OPENAI_TTS_INSTRUCTIONS",
      "Speak like a calm, friendly professional in a business meeting. Natural pace, warm tone, clear pronunciation."
    ),
  },
  // Live simultaneous interpretation of the host's Bangla (hands-free, "OpenAI live" engine).
  realtime: {
    url: readString("OPENAI_REALTIME_TRANSLATE_URL", "wss://api.openai.com/v1/realtime/translations"),
    model: readString("OPENAI_REALTIME_TRANSLATE_MODEL", "gpt-realtime-translate"),
    // Source-language captions for the panel; translation itself runs from the audio.
    transcribeModel: readString("OPENAI_REALTIME_TRANSCRIBE_MODEL", "gpt-realtime-whisper"),
    // near_field (headset/close mic), far_field (laptop/room mic) or none.
    noiseReduction: readString("OPENAI_REALTIME_NOISE_REDUCTION", "near_field").toLowerCase(),
  },
  groq: {
    apiKey: readString("GROQ_API_KEY"),
    baseUrl: readString("GROQ_BASE_URL", "https://api.groq.com/openai/v1"),
    sttModel: readString("GROQ_STT_MODEL", "whisper-large-v3"),
  },
  deepgram: {
    apiKey: readString("DEEPGRAM_API_KEY"),
    model: readString("DEEPGRAM_MODEL", "nova-3"),
  },
  gemini: {
    apiKey: readString("GEMINI_API_KEY"),
    model: readString("GEMINI_MODEL", "gemini-2.5-flash"),
  },
  elevenlabs: {
    apiKey: readString("ELEVENLABS_API_KEY"),
    voiceId: readString("ELEVENLABS_VOICE_ID"),
    // Gender voices; both default to ELEVENLABS_VOICE_ID so one id still works.
    voiceIds: {
      male: readString("ELEVENLABS_VOICE_ID_MALE", readString("ELEVENLABS_VOICE_ID")),
      female: readString("ELEVENLABS_VOICE_ID_FEMALE", readString("ELEVENLABS_VOICE_ID")),
    } as Record<string, string>,
    model: readString("ELEVENLABS_MODEL", "eleven_multilingual_v2"),
  },
  edge: {
    // One male and one female Edge voice per language, for the voice dropdown.
    voices: {
      bn: {
        male: readString("EDGE_TTS_VOICE_BN_MALE", "bn-BD-PradeepNeural"),
        female: readString("EDGE_TTS_VOICE_BN_FEMALE", "bn-BD-NabanitaNeural"),
      } as Record<string, string>,
      ja: {
        male: readString("EDGE_TTS_VOICE_JA_MALE", "ja-JP-KeitaNeural"),
        female: readString("EDGE_TTS_VOICE_JA_FEMALE", "ja-JP-NanamiNeural"),
      } as Record<string, string>,
      en: {
        male: readString("EDGE_TTS_VOICE_EN_MALE", "en-US-AndrewMultilingualNeural"),
        female: readString("EDGE_TTS_VOICE_EN_FEMALE", "en-US-AvaMultilingualNeural"),
      } as Record<string, string>,
    } as Record<string, Record<string, string>>,
  },
  custom: {
    sttUrl: readString("CUSTOM_STT_URL"),
    sttKey: readString("CUSTOM_STT_KEY"),
    llmUrl: readString("CUSTOM_LLM_URL"),
    llmKey: readString("CUSTOM_LLM_KEY"),
    llmModel: readString("CUSTOM_LLM_MODEL"),
    llmJsonMode: readBool("CUSTOM_LLM_JSON_MODE", true),
    // low | medium | high for reasoning models (gpt-oss, Qwen3). Empty = don't send.
    llmReasoningEffort: readString("CUSTOM_LLM_REASONING_EFFORT").toLowerCase(),
    ttsUrl: readString("CUSTOM_TTS_URL"),
    ttsKey: readString("CUSTOM_TTS_KEY"),
  },
}

export type AppConfig = typeof config

export const requireValue = (value: string, envKey: string, provider: string): string => {
  if (!value) throw new Error(`${envKey} is required when using the "${provider}" provider`)
  return value
}
