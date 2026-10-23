// Terms are comma-separated in .env and reach two very different places: the
// live session's instructions and the clip-by-clip Whisper prompt. They were
// parsed separately, so one path deduped nothing and the other passed the raw
// comma-separated string through. One parser, so a term behaves the same either
// way.
export const MAX_GLOSSARY_TERMS = 50

// Deduped case-insensitively, keeping the first spelling the author wrote:
// "CPL" and "cpl" are the same word to a model, so listing both only invites
// it to pick whichever it hears. Internal whitespace is collapsed because a
// stray newline from a wrapped .env line would otherwise split one term in two.
export const parseGlossaryTerms = (raw: string, limit = MAX_GLOSSARY_TERMS): string[] => {
  const seen = new Set<string>()
  const terms: string[] = []
  for (const part of raw.split(",")) {
    const term = part.trim().replace(/\s+/g, " ")
    if (!term) continue
    const key = term.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    terms.push(term)
    if (terms.length >= limit) break
  }
  return terms
}