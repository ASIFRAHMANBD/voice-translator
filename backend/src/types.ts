export type Direction = "outgoing" | "incoming"
export type TargetLang = "ja" | "en"
export type Speaker = "host" | "client"

export type ConversationTurn = { speaker: Speaker; text: string }

export type SttResult = { text: string; lang: string }
export type SttOptions = { lang?: string; prompt?: string }
export type TranslateInput = {
  direction: Direction
  text: string
  sourceLang: string
  targetLang: string
  context?: ConversationTurn[]
  glossary?: string
  // Ask for the reply analysis in the same call (slower); otherwise use analyze().
  withAnalysis?: boolean
}
export type TranslateResult = { translated_text: string; analysis: string; understood: string; unclear: boolean }

export type SummaryTurn = { speaker: Speaker; name: string; text: string; translation: string }
export type SummaryInput = { turns: SummaryTurn[]; glossary?: string }

// rate: 1 = normal, 0.9 = 10% slower.
export type TtsOptions = { rate?: number }
export type TtsResult = { audio: Buffer; mime: string }

export type SttAdapter = {
  name: string
  transcribe: (audio: Buffer, mime: string, options?: SttOptions) => Promise<SttResult>
}
export type LlmAdapter = {
  name: string
  translate: (input: TranslateInput) => Promise<TranslateResult>
  // Short Bangla note on what the client wants plus reply ideas.
  analyze: (input: TranslateInput) => Promise<string>
  summarize: (input: SummaryInput) => Promise<string>
}
export type TtsAdapter = {
  name: string
  synthesize: (text: string, lang: string, options?: TtsOptions) => Promise<TtsResult>
}

// Either recorded audio (transcribed here) or text already recognized elsewhere
// (Chrome speech recognition for the host, Meet captions for the client).
export type VoiceInput = { kind: "audio"; audio: Buffer; mime: string } | { kind: "text"; text: string; lang?: string }

export type ProcessVoiceRequest = {
  input: VoiceInput
  direction: Direction
  targetLang: TargetLang
  context: ConversationTurn[]
  speak: boolean
  voiceRate: number
}

export type StageTimings = { stt_ms: number; llm_ms: number; tts_ms: number; total_ms: number }

export type ProcessVoiceResponse = {
  transcript: string
  detected_lang: string
  translated_text: string
  understood: string
  analysis: string
  // Audio covers the first sentence only; the rest is fetched from /api/tts while it plays.
  audio_base64: string
  audio_mime: string
  remaining_sentences: string[]
  voice_lang: string
  empty: boolean
  unclear: boolean
  voice_error: string
  timings: StageTimings
}
