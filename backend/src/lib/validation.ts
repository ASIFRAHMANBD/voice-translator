import type { Voice } from "../types.js"

export const MIN_VOICE_RATE = 0.7
export const MAX_VOICE_RATE = 1.3
export const MAX_TEXT_LENGTH = 1000

// Voice speed multiplier from a form/JSON field; anything invalid means normal speed.
export const parseVoiceRate = (raw: unknown): number => {
  const value = typeof raw === "number" ? raw : Number.parseFloat(String(raw ?? ""))
  if (!Number.isFinite(value)) return 1
  return Math.min(MAX_VOICE_RATE, Math.max(MIN_VOICE_RATE, value))
}

// Which voice to speak with; anything invalid means the provider's own voice.
export const parseVoice = (raw: unknown): Voice => {
  const value = String(raw ?? "").trim().toLowerCase()
  return value === "male" || value === "female" ? value : "default"
}
