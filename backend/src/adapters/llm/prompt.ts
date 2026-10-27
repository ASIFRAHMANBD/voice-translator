import { languageName } from "../../lib/lang.js"
import type { ConversationTurn, SummaryInput, SummaryTurn, TranslateInput, TranslateResult } from "../../types.js"

const SPEAKER_LABELS: Record<ConversationTurn["speaker"], string> = { host: "Host", client: "Client" }

const formatContext = (context: ConversationTurn[] | undefined): string => {
  if (!context || context.length === 0) return ""
  const lines = context.map((turn) => `${SPEAKER_LABELS[turn.speaker]}: ${turn.text}`)
  return `Recent conversation (context only, do not translate):\n${lines.join("\n")}\n\n`
}

export const buildMessages = ({ direction, text, sourceLang, targetLang, context, glossary, withAnalysis }: TranslateInput) => {
  const source = languageName(sourceLang)
  const target = languageName(targetLang)
  const speaker = direction === "outgoing" ? "Host" : "Client"

  const analysisRule =
    direction === "incoming" && withAnalysis
      ? `"analysis": in Bangla, one short sentence on what the client wants, then 1-3 bullet points ("• ...") the host could say in reply. Keep it under 60 words.`
      : ""

  const styleRule =
    targetLang === "ja"
      ? "Use natural business Japanese (丁寧語, です/ます調). Do not add greetings, apologies or set phrases the speaker did not say."
      : targetLang === "en"
        ? "Use natural, polite business English."
        : [
            "Write the Bangla a Bangladeshi IT professional actually speaks in meetings (চলিত ভাষা, polite আপনি).",
            "Keep common English business and tech words the way they are said in Bangla, written in Bangla script (ডিজাইন, টেস্ট রিপোর্ট, ডেডলাইন, লগইন, ফিচার, কোটেশন).",
            "Translate Japanese set phrases by their function, not word by word (お世話になっております → a short friendly greeting such as \"আশা করি ভালো আছেন\"; よろしくお願いします → \"ধন্যবাদ\"; 恐れ入りますが → \"কিছু মনে না করলে\").",
            "Write numbers, dates and amounts with digits (১৫ তারিখ, ২ সপ্তাহ).",
          ].join(" ")

  // Hosts speak everyday Bangla; colloquial verb forms mean the same as the standard ones.
  const sourceRule =
    sourceLang === "bn"
      ? "The host speaks everyday spoken Bangla: colloquial forms such as আসতেছি, করতেছি, যাইতেছি, করসি mean the same as আসছি, করছি, যাচ্ছি, করেছি."
      : ""

  const system = [
    "You are a professional simultaneous interpreter in a live business meeting between a Bangla-speaking host and Japanese/English-speaking clients.",
    `Interpret the speaker's words from ${source} into spoken ${target}.`,
    "Accuracy rules, most important first:",
    "1. Be faithful. Translate exactly what was said: every clause, number, name, date, negation and question. Never add, drop, summarize or embellish anything.",
    "2. The text comes from live speech recognition and may be only part of a sentence that continues in the next message. Translate the part as it is; never invent a beginning or an ending.",
    "3. Fix a recognition error only when the intended word is obvious from both the sound and the conversation. If unsure, keep the literal meaning. Never swap a word for a different word just because it sounds similar.",
    "4. Keep names, product names and technical terms; write them the way a native speaker of the target language would.",
    glossary ? `Known names and terms: ${glossary}` : "",
    sourceRule,
    styleRule,
    "Write it the way a person would say it aloud: natural spoken sentences, no lists, brackets, emoji, or romanization. Keep the sentence type: a question stays a question.",
    "Respond with ONLY a JSON object with exactly these keys:",
    `"unclear": boolean, true only if the text has no recognizable words at all (pure noise); otherwise false.`,
    direction === "outgoing"
      ? `"understood": the speaker's words in clean ${source}, with only the obvious recognition errors fixed (empty if unclear).`
      : "",
    `"translated_text": the translation, to be read by text-to-speech.`,
    analysisRule,
  ]
    .filter(Boolean)
    .join("\n")

  const user = `${formatContext(context)}${speaker} now says:\n${text}`
  return { system, user }
}

// Runs alongside the translation, so the Bangla voice never waits for it.
export const buildAnalysisMessages = ({ text, context, glossary }: TranslateInput) => {
  const system = [
    "You help a Bangla-speaking host (Bangladesh, software company) in a live business meeting with a Japanese/English-speaking client.",
    "Given what the client just said, write in Bangla: one short sentence on what the client wants or asks, then 1-3 short bullet points (\"• ...\") the host could say in reply.",
    "Stay strictly within what was said; never invent facts, dates or commitments. Under 60 words, plain text, no markdown.",
    "If it is only a greeting or small talk, write one short sentence and no bullets.",
    glossary ? `Known names and terms: ${glossary}` : "",
  ]
    .filter(Boolean)
    .join("\n")
  const user = `${formatContext(context)}Client now says:\n${text}`
  return { system, user }
}

const formatSummaryTurn = ({ speaker, name, text, translation }: SummaryTurn): string => {
  const who = speaker === "host" ? "Host" : name ? `Client (${name})` : "Client"
  return translation ? `${who}: ${text}\n  [translation: ${translation}]` : `${who}: ${text}`
}

export const buildSummaryMessages = ({ turns, glossary }: SummaryInput) => {
  const system = [
    "You write meeting minutes for a Bangla-speaking host after a business meeting with Japanese/English-speaking clients.",
    "The transcript comes from live speech recognition and machine translation, so expect errors; infer the intended meaning, and never invent facts, dates, numbers or commitments that are not in it.",
    glossary ? `Known names and terms: ${glossary}` : "",
    "Write plain text, no markdown tables or bold. Write two versions of the same minutes: first Bangla, then English.",
    "Start the Bangla version with the line \"বাংলা\" and the English one with the line \"English\".",
    "Several people may speak in the same meeting. Keep the speaker's name on every point: say \"<name> said ...\" or \"<name> asked ...\" so the host knows who said what. Never merge two people's points into one.",
    "Each version has these headings, in this order, each followed by short \"• \" bullet points (write \"None\"/\"নেই\" when empty):",
    "Summary (2-3 sentences) / সারাংশ",
    "Decisions / সিদ্ধান্ত",
    "Action items: who, what, and by when if mentioned / করণীয়",
    "Client requests and concerns / ক্লায়েন্টের চাওয়া ও উদ্বেগ",
    "Open questions / খোলা প্রশ্ন",
    "What each person said / কে কী বলেছেন",
  ]
    .filter(Boolean)
    .join("\n")

  const user = `Meeting transcript, in order:\n\n${turns.map(formatSummaryTurn).join("\n")}`
  return { system, user }
}

// Accepts raw JSON, fenced JSON, or JSON embedded in prose.
export const parseTranslateResult = (raw: string): TranslateResult => {
  const candidates = [raw.trim()]
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) candidates.push(fenced[1].trim())
  const firstBrace = raw.indexOf("{")
  const lastBrace = raw.lastIndexOf("}")
  if (firstBrace !== -1 && lastBrace > firstBrace) candidates.push(raw.slice(firstBrace, lastBrace + 1))

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Partial<TranslateResult>
      if (typeof parsed.translated_text === "string") {
        const unclear = parsed.unclear === true
        return {
          translated_text: unclear ? "" : parsed.translated_text.trim(),
          analysis: typeof parsed.analysis === "string" ? parsed.analysis.trim() : "",
          understood: !unclear && typeof parsed.understood === "string" ? parsed.understood.trim() : "",
          unclear,
        }
      }
    } catch {
      // try the next candidate
    }
  }
  throw new Error("LLM did not return the expected JSON { translated_text, analysis }")
}
