import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts"
import type { AppConfig } from "../../config.js"
import { ProviderError } from "../../lib/http.js"
import type { TtsAdapter } from "../../types.js"

const OUTPUT = OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3
// A reused socket that went stale hangs instead of failing, so give it a short
// deadline and fall back to a fresh connection.
const REUSED_TIMEOUT_MS = 6_000

type VoiceConnection = { tts: MsEdgeTTS; ready: Promise<void> }

// SSML relative rate: 0.9 -> "-10%", 1.1 -> "+10%".
const toRelativePercent = (rate: number): string => {
  const percent = Math.round((rate - 1) * 100)
  return `${percent >= 0 ? "+" : ""}${percent}%`
}

const collectStream = (stream: NodeJS.ReadableStream, timeoutMs: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const timer = setTimeout(() => reject(new ProviderError("edge-tts", "request timed out")), timeoutMs)
    stream.on("data", (chunk: Buffer) => chunks.push(chunk))
    stream.on("end", () => {
      clearTimeout(timer)
      resolve(Buffer.concat(chunks))
    })
    stream.on("error", (err: Error) => {
      clearTimeout(timer)
      reject(new ProviderError("edge-tts", err.message))
    })
  })

// Free Microsoft Edge read-aloud voices; no API key. Unofficial endpoint, so
// prefer a paid provider for anything client-critical.
export const createEdgeTts = (config: AppConfig): TtsAdapter => {
  // Opening the websocket costs ~0.6 s, so keep one connection per voice and
  // run that voice's requests one at a time.
  const connections = new Map<string, VoiceConnection>()
  const queues = new Map<string, Promise<unknown>>()

  const openConnection = (voice: string): VoiceConnection => {
    const tts = new MsEdgeTTS()
    const connection = { tts, ready: tts.setMetadata(voice, OUTPUT) }
    connections.set(voice, connection)
    return connection
  }

  const dropConnection = (voice: string, connection: VoiceConnection) => {
    if (connections.get(voice) === connection) connections.delete(voice)
    try {
      connection.tts.close()
    } catch {
      // already closed
    }
  }

  const synthesizeOnce = async (voice: string, text: string, rate: number, reused: boolean): Promise<Buffer> => {
    const connection = connections.get(voice) ?? openConnection(voice)
    try {
      await connection.ready
      const { audioStream } = connection.tts.toStream(text, { rate: toRelativePercent(rate) })
      const audio = await collectStream(audioStream, reused ? REUSED_TIMEOUT_MS : config.providerTimeoutMs)
      if (audio.length === 0) throw new ProviderError("edge-tts", "returned no audio")
      return audio
    } catch (err) {
      dropConnection(voice, connection)
      throw err
    }
  }

  const synthesizeWithRetry = async (voice: string, text: string, rate: number): Promise<Buffer> => {
    const hadConnection = connections.has(voice)
    try {
      return await synthesizeOnce(voice, text, rate, hadConnection)
    } catch (err) {
      const rateLimited = err instanceof Error && /\b429\b/.test(err.message)
      if (!hadConnection || rateLimited) throw err
      return synthesizeOnce(voice, text, rate, false)
    }
  }

  return {
    name: "edge-tts",
    synthesize: async (text, lang, { rate = 1 } = {}) => {
      const voice = config.edge.voices[lang]
      if (!voice) throw new ProviderError("edge-tts", `No voice configured for language "${lang}"`)

      const previous = queues.get(voice) ?? Promise.resolve()
      const job = previous.catch(() => {}).then(() => synthesizeWithRetry(voice, text, rate))
      queues.set(voice, job)
      try {
        return { audio: await job, mime: "audio/mpeg" }
      } catch (err) {
        if (err instanceof ProviderError) throw err
        throw new ProviderError("edge-tts", err instanceof Error ? err.message : "synthesis failed")
      }
    },
  }
}
