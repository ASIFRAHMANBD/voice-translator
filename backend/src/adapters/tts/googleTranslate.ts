import { providerFetch } from "../../lib/http.js"
import type { TtsAdapter } from "../../types.js"

const ENDPOINT = "https://translate.google.com/translate_tts"
// The endpoint rejects longer inputs, so long translations are sent in pieces.
const MAX_CHUNK_CHARS = 180
const SENTENCE_BREAK = /(?<=[.!?。！？、,，;।])\s*/u

const splitText = (text: string): string[] => {
  const chunks: string[] = []
  let current = ""
  const pieces = text.split(SENTENCE_BREAK).flatMap((piece) =>
    piece.length <= MAX_CHUNK_CHARS ? [piece] : piece.match(new RegExp(`.{1,${MAX_CHUNK_CHARS}}`, "gsu")) ?? []
  )
  pieces.forEach((piece) => {
    if ((current + piece).length > MAX_CHUNK_CHARS && current) {
      chunks.push(current.trim())
      current = ""
    }
    current += piece
  })
  if (current.trim()) chunks.push(current.trim())
  return chunks
}

// Free Google Translate read-aloud voice; no API key. Unofficial and plainer than
// Edge, so it is meant as a fallback when the primary voice is unavailable.
// It has no speed control, so the voice speed setting does not apply here, and the
// endpoint takes no voice parameter, so the male/female choice does not apply either.
export const createGoogleTranslateTts = (): TtsAdapter => ({
  name: "google-translate",
  // The endpoint has no voice parameter, so it cannot honour a male/female choice.
  supportsGender: false,
  synthesize: async (text, lang) => {
    const parts = await Promise.all(
      splitText(text).map(async (chunk) => {
        const query = new URLSearchParams({ ie: "UTF-8", client: "tw-ob", tl: lang, q: chunk })
        const res = await providerFetch("google-translate-tts", `${ENDPOINT}?${query}`, {
          headers: { "User-Agent": "Mozilla/5.0" },
        })
        return Buffer.from(await res.arrayBuffer())
      })
    )
    return { audio: Buffer.concat(parts), mime: "audio/mpeg" }
  },
})
