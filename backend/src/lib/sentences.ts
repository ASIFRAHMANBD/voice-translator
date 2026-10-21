// Break after sentence-ending punctuation (Japanese, Bangla dari, Western). A "."
// only counts when followed by whitespace, so "3.5" and "Next.js" stay intact.
const SENTENCE_BREAK = /(?<=[。！？!?।]|\.(?=\s))\s*/u
// Short translations gain nothing from splitting; pieces below this length are
// merged with the next so we never request audio for a single word.
const MIN_SPLIT_CHARS = 60
const MIN_CHUNK_CHARS = 25

export const splitForSpeech = (text: string, lang: string): string[] => {
  const trimmed = text.trim()
  if (trimmed.length < MIN_SPLIT_CHARS) return trimmed ? [trimmed] : []

  const joiner = lang === "ja" ? "" : " "
  const chunks: string[] = []
  let current = ""
  trimmed
    .split(SENTENCE_BREAK)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .forEach((sentence) => {
      current = current ? `${current}${joiner}${sentence}` : sentence
      if (current.length >= MIN_CHUNK_CHARS) {
        chunks.push(current)
        current = ""
      }
    })
  if (current) {
    if (chunks.length === 0) chunks.push(current)
    else chunks[chunks.length - 1] = `${chunks[chunks.length - 1]}${joiner}${current}`
  }
  return chunks
}
