const LANGUAGE_NAMES: Record<string, string> = {
  bn: "Bangla (Bengali)",
  ja: "Japanese",
  en: "English",
}

const NAME_TO_CODE: Record<string, string> = {
  bengali: "bn",
  bangla: "bn",
  japanese: "ja",
  english: "en",
}

// Providers report languages as "ja", "ja-JP", "japanese", etc.
export const normalizeLang = (raw: string | undefined | null): string => {
  if (!raw) return ""
  const value = raw.trim().toLowerCase()
  if (NAME_TO_CODE[value]) return NAME_TO_CODE[value]
  return value.split(/[-_]/)[0]
}

export const languageName = (code: string): string => LANGUAGE_NAMES[code] || code || "the detected language"

// Text from captions or live transcription carries no language tag. The client
// speaks Japanese or English, which differ by script; Bangla has its own script too.
export const guessLangFromText = (text: string): string => {
  if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(text)) return "ja"
  if (/\p{Script=Bengali}/u.test(text)) return "bn"
  if (/\p{Script=Latin}/u.test(text)) return "en"
  return ""
}
