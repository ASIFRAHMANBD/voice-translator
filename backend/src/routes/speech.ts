import { randomUUID } from "node:crypto"
import express, { Router, type Request, type Response } from "express"
import { ProviderError } from "../lib/http.js"
import { MAX_TEXT_LENGTH, parseVoiceRate } from "../lib/validation.js"
import { DemoModeError, summarizeMeeting, synthesizeSpeech } from "../services/aiService.js"
import type { SummaryTurn } from "../types.js"

const VOICE_LANGS = new Set(["bn", "ja", "en"])
const MAX_SUMMARY_TURNS = 300
const MAX_SUMMARY_FIELD = 600
const MAX_NAME_LENGTH = 60

const sendFailure = (res: Response, requestId: string, label: string, err: unknown) => {
  const message = err instanceof Error ? err.message : "Unknown error"
  console.error(`[${requestId}] ${label} failed: ${message}`)
  if (err instanceof DemoModeError) {
    res.status(503).json({ error: message, request_id: requestId })
    return
  }
  res.status(err instanceof ProviderError ? 502 : 500).json({
    error: err instanceof ProviderError ? message : "Internal server error",
    request_id: requestId,
  })
}

const cleanString = (value: unknown, max: number): string => (typeof value === "string" ? value.trim().slice(0, max) : "")

// Untrusted input from the page: keep only well-formed turns, capped in count and size.
const parseSummaryTurns = (raw: unknown): SummaryTurn[] => {
  if (!Array.isArray(raw)) return []
  return raw
    .slice(-MAX_SUMMARY_TURNS)
    .filter(
      (turn): turn is Record<string, unknown> =>
        typeof turn === "object" && turn !== null && (turn.speaker === "host" || turn.speaker === "client")
    )
    .map((turn) => ({
      speaker: turn.speaker as SummaryTurn["speaker"],
      name: cleanString(turn.name, MAX_NAME_LENGTH),
      text: cleanString(turn.text, MAX_SUMMARY_FIELD),
      translation: cleanString(turn.translation, MAX_SUMMARY_FIELD),
    }))
    .filter((turn) => turn.text.length > 0)
}

// POST /api/tts { text, lang, voice_rate? } -> { audio_base64, audio_mime }
const handleTts = async (req: Request, res: Response) => {
  const requestId = randomUUID().slice(0, 8)
  const text = cleanString(req.body?.text, MAX_TEXT_LENGTH + 1)
  const lang = String(req.body?.lang ?? "")
  if (!text || text.length > MAX_TEXT_LENGTH) {
    res.status(400).json({ error: `Field "text" is required, at most ${MAX_TEXT_LENGTH} characters` })
    return
  }
  if (!VOICE_LANGS.has(lang)) {
    res.status(400).json({ error: "Field \"lang\" must be \"bn\", \"ja\" or \"en\"" })
    return
  }
  try {
    const startedAt = performance.now()
    const speech = await synthesizeSpeech(text, lang, parseVoiceRate(req.body?.voice_rate))
    console.info(`[${requestId}] tts ${lang} text(${text.length}) ${Math.round(performance.now() - startedAt)}ms`)
    res.json({ audio_base64: speech.audio.toString("base64"), audio_mime: speech.mime })
  } catch (err) {
    sendFailure(res, requestId, "tts", err)
  }
}

// POST /api/summary { turns: [{ speaker, name?, text, translation? }] } -> { summary }
const handleSummary = async (req: Request, res: Response) => {
  const requestId = randomUUID().slice(0, 8)
  const turns = parseSummaryTurns(req.body?.turns)
  if (turns.length === 0) {
    res.status(400).json({ error: "Field \"turns\" must contain at least one turn with text" })
    return
  }
  try {
    const startedAt = performance.now()
    const summary = await summarizeMeeting(turns)
    console.info(`[${requestId}] summary ${turns.length} turns ${Math.round(performance.now() - startedAt)}ms`)
    res.json({ summary })
  } catch (err) {
    sendFailure(res, requestId, "summary", err)
  }
}

export const speechRouter = Router()
speechRouter.post("/api/tts", express.json({ limit: "16kb" }), handleTts)
speechRouter.post("/api/summary", express.json({ limit: "512kb" }), handleSummary)
