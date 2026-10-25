import { randomUUID } from "node:crypto"
import { Router, type NextFunction, type Request, type Response } from "express"
import multer from "multer"
import { config } from "../config.js"
import { ProviderError } from "../lib/http.js"
import { MAX_TEXT_LENGTH, parseVoice, parseVoiceRate } from "../lib/validation.js"
import { processVoice } from "../services/aiService.js"
import type { ConversationTurn, Direction, TargetLang } from "../types.js"

const DIRECTIONS: Direction[] = ["outgoing", "incoming"]
const TARGET_LANGS: TargetLang[] = ["ja", "en"]
const ACCEPTED_MIME = /^(audio\/|video\/webm)/
const MAX_CONTEXT_TURNS = 6
const MAX_CONTEXT_TEXT = 300

const upload = multer({
  storage: multer.memoryStorage(),
  // Fields: audio, text, lang, direction, target_lang, tts, voice_rate, voice, context.
  limits: { fileSize: config.maxUploadBytes, files: 1, fields: 9, fieldSize: 16 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, ACCEPTED_MIME.test(file.mimetype)),
})

// Optional JSON [{ speaker: "host" | "client", text }]; anything malformed is ignored.
const parseContext = (raw: unknown): ConversationTurn[] => {
  if (typeof raw !== "string" || raw.length === 0) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  return parsed
    .filter(
      (turn): turn is ConversationTurn =>
        typeof turn === "object" &&
        turn !== null &&
        (turn.speaker === "host" || turn.speaker === "client") &&
        typeof turn.text === "string" &&
        turn.text.trim().length > 0
    )
    .slice(-MAX_CONTEXT_TURNS)
    .map((turn) => ({ speaker: turn.speaker, text: turn.text.trim().slice(0, MAX_CONTEXT_TEXT) }))
}

const handleUpload = (req: Request, res: Response, next: NextFunction) => {
  upload.single("audio")(req, res, (err: unknown) => {
    if (!err) return next()
    const isTooLarge = err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE"
    res.status(isTooLarge ? 413 : 400).json({
      error: isTooLarge ? `Audio exceeds ${config.maxUploadBytes / 1024 / 1024} MB` : "Invalid upload",
    })
  })
}

const handleProcessVoice = async (req: Request, res: Response) => {
  const requestId = randomUUID().slice(0, 8)
  const direction = String(req.body?.direction ?? "") as Direction
  const targetLang = String(req.body?.target_lang ?? "ja") as TargetLang

  const text = typeof req.body?.text === "string" ? req.body.text.trim() : ""
  const hasAudio = Boolean(req.file && req.file.size > 0)

  if (!DIRECTIONS.includes(direction)) {
    res.status(400).json({ error: "Field \"direction\" must be \"outgoing\" or \"incoming\"" })
    return
  }
  if (!hasAudio && !text) {
    res.status(400).json({ error: "Send an \"audio\" file or a \"text\" field" })
    return
  }
  if (text.length > MAX_TEXT_LENGTH) {
    res.status(400).json({ error: `Field "text" must be at most ${MAX_TEXT_LENGTH} characters` })
    return
  }
  if (!TARGET_LANGS.includes(targetLang)) {
    res.status(400).json({ error: "Field \"target_lang\" must be \"ja\" or \"en\"" })
    return
  }

  try {
    const result = await processVoice({
      input: req.file && hasAudio
        ? { kind: "audio", audio: req.file.buffer, mime: req.file.mimetype }
        : { kind: "text", text, lang: typeof req.body?.lang === "string" ? req.body.lang.trim() : undefined },
      direction,
      targetLang,
      context: parseContext(req.body?.context),
      speak: req.body?.tts !== "off",
      voiceRate: parseVoiceRate(req.body?.voice_rate),
      voice: parseVoice(req.body?.voice),
    })
    const { stt_ms, llm_ms, tts_ms, total_ms } = result.timings
    console.info(
      `[${requestId}] ${direction}${direction === "outgoing" ? `->${targetLang}` : ""} ` +
        `${req.file && hasAudio ? `${req.file.size}B` : `text(${text.length})`} stt=${stt_ms}ms llm=${llm_ms}ms tts=${tts_ms}ms total=${total_ms}ms` +
        (result.empty ? " (empty)" : "")
    )
    res.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error"
    console.error(`[${requestId}] ${direction} failed: ${message}`)
    res.status(err instanceof ProviderError ? 502 : 500).json({
      error: err instanceof ProviderError ? message : "Internal server error",
      request_id: requestId,
    })
  }
}

export const processVoiceRouter = Router()
processVoiceRouter.post("/api/process-voice", handleUpload, handleProcessVoice)
