import type { IncomingMessage } from "node:http"
import type { Duplex } from "node:stream"
import cors from "cors"
import express, { type NextFunction, type Request, type Response } from "express"
import { WebSocketServer } from "ws"
import { config } from "./config.js"
import { isAllowedOrigin, tokensMatch } from "./lib/security.js"
import { processVoiceRouter } from "./routes/processVoice.js"
import { speechRouter } from "./routes/speech.js"
import { describeProviders } from "./services/aiService.js"
import { handleTranscribeClient } from "./services/realtimeTranscribe.js"
import { handleTranslateClient } from "./services/realtimeTranslate.js"

const LIVE_PATH = "/ws/translate"
// Live transcription of the client's Japanese/English (translated to Bangla per sentence).
const TRANSCRIBE_PATH = "/ws/transcribe"
const LIVE_TARGET_LANGS = new Set(["ja", "en"])

// CORS headers only stop a browser from reading the response; a web page can
// still fire a multipart POST at localhost. Reject foreign origins outright.
const rejectForeignOrigins = (req: Request, res: Response, next: NextFunction) => {
  if (isAllowedOrigin(req.get("origin"))) return next()
  res.status(403).json({ error: "Origin not allowed" })
}

const requireToken = (req: Request, res: Response, next: NextFunction) => {
  if (!config.apiToken) return next()
  const header = req.get("authorization") ?? ""
  const provided = header.startsWith("Bearer ") ? header.slice(7) : ""
  if (tokensMatch(provided, config.apiToken)) return next()
  res.status(401).json({ error: "Missing or invalid API token" })
}

const app = express()
app.disable("x-powered-by")
app.use(cors({ origin: (origin, cb) => cb(null, isAllowedOrigin(origin)), methods: ["GET", "POST"] }))
app.use(rejectForeignOrigins)

app.get("/health", (_req, res) => {
  res.json({ ok: true, providers: describeProviders(), live: describeLive() })
})

app.use(requireToken, processVoiceRouter, speechRouter)

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" })
})

const describeLive = () =>
  config.demoMode || !config.openai.apiKey
    ? { available: false }
    : { available: true, model: config.realtime.model, transcription: config.realtime.transcribeModel }

// ---------------------------------------------------------------------------
// Live interpreter WebSocket: browsers can't set headers on WebSockets, so the
// token comes as a query parameter; the Origin check matches the HTTP routes.
// ---------------------------------------------------------------------------
const liveServer = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 })

const rejectUpgrade = (socket: Duplex, status: number, message: string) => {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

// Dead connections (Wi-Fi switch, sleeping laptop) never send a close frame. Ping every
// client; one that missed the previous round is terminated, which also ends its paid
// OpenAI session via the handlers' close listeners.
const HEARTBEAT_INTERVAL_MS = 15_000
const PING_MESSAGE = '{"type":"ping"}'
const PONG_MESSAGE = '{"type":"pong"}'
const clientAlive = new WeakMap<object, boolean>()

setInterval(() => {
  for (const client of liveServer.clients) {
    if (clientAlive.get(client) === false) {
      client.terminate()
      continue
    }
    clientAlive.set(client, false)
    client.ping()
  }
}, HEARTBEAT_INTERVAL_MS).unref()

const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  const isTranscribe = url.pathname === TRANSCRIBE_PATH
  if (url.pathname !== LIVE_PATH && !isTranscribe) return rejectUpgrade(socket, 404, "Not Found")
  if (!isAllowedOrigin(req.headers.origin)) return rejectUpgrade(socket, 403, "Forbidden")
  if (config.apiToken && !tokensMatch(url.searchParams.get("token") ?? "", config.apiToken)) {
    return rejectUpgrade(socket, 401, "Unauthorized")
  }
  const target = url.searchParams.get("target") ?? ""
  if (!isTranscribe && !LIVE_TARGET_LANGS.has(target)) return rejectUpgrade(socket, 400, "Bad Request")

  liveServer.handleUpgrade(req, socket, head, (client) => {
    clientAlive.set(client, true)
    client.on("pong", () => clientAlive.set(client, true))
    // The extension's own heartbeat: tiny text frames only, audio frames are skipped cheaply.
    client.on("message", (raw) => {
      if (!Buffer.isBuffer(raw) || raw.length > PING_MESSAGE.length) return
      if (raw.toString() === PING_MESSAGE) client.send(PONG_MESSAGE)
    })
    if (!describeLive().available) {
      client.send(JSON.stringify({
        type: "error",
        fatal: true,
        message: config.demoMode
          ? "Live interpreter needs real OpenAI access: set DEMO_MODE=false in backend/.env."
          : "Live interpreter needs OPENAI_API_KEY in backend/.env.",
      }))
      client.close(1000)
      return
    }
    if (isTranscribe) handleTranscribeClient(client)
    else handleTranslateClient(client, target)
  })
}

const server = app.listen(config.port, config.host, () => {
  const providers = describeProviders()
  console.info(`Meet AI Interpreter backend on http://${config.host}:${config.port}`)
  console.info(`Providers: ${JSON.stringify(providers)}`)
  console.info(`Live interpreter: ${JSON.stringify(describeLive())} at ws://${config.host}:${config.port}${LIVE_PATH}`)
  if (!config.apiToken) console.warn("API_TOKEN is not set; any local process can call this server.")
  if (config.allowedOrigins.length === 0) console.warn("ALLOWED_ORIGINS is not set; allowing any chrome-extension:// origin.")
})
server.on("upgrade", handleUpgrade)
