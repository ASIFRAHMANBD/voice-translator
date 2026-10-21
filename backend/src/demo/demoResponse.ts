import type { Direction, ProcessVoiceResponse, TargetLang } from "../types.js"

const SAMPLE_RATE = 22_050

// A short two-note chime rendered as 16-bit PCM WAV, so demo mode exercises the
// extension's decode-and-play path without any TTS provider.
const renderChimeWav = (): Buffer => {
  const notes = [
    { freq: 660, seconds: 0.18 },
    { freq: 880, seconds: 0.28 },
  ]
  const totalSamples = notes.reduce((sum, note) => sum + Math.round(note.seconds * SAMPLE_RATE), 0)
  const dataBytes = totalSamples * 2
  const wav = Buffer.alloc(44 + dataBytes)

  wav.write("RIFF", 0)
  wav.writeUInt32LE(36 + dataBytes, 4)
  wav.write("WAVE", 8)
  wav.write("fmt ", 12)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(SAMPLE_RATE, 24)
  wav.writeUInt32LE(SAMPLE_RATE * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write("data", 36)
  wav.writeUInt32LE(dataBytes, 40)

  let offset = 44
  notes.forEach(({ freq, seconds }) => {
    const count = Math.round(seconds * SAMPLE_RATE)
    for (let i = 0; i < count; i++) {
      const envelope = Math.min(1, i / 300, (count - i) / 600)
      const sample = Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE) * 0.35 * envelope
      wav.writeInt16LE(Math.round(sample * 32767), offset)
      offset += 2
    }
  })
  return wav
}

const CHIME_BASE64 = renderChimeWav().toString("base64")

const OUTGOING_TRANSLATIONS: Record<TargetLang, string> = {
  ja: "こんにちは。プロジェクトは来月の十五日までに完了する予定です。",
  en: "Hello. We plan to finish the project by the 15th of next month.",
}

export const buildDemoResponse = (direction: Direction, targetLang: TargetLang): ProcessVoiceResponse => {
  const base = {
    audio_base64: CHIME_BASE64,
    audio_mime: "audio/wav",
    empty: false,
    unclear: false,
    understood: "",
    voice_error: "",
    remaining_sentences: [],
    voice_lang: direction === "outgoing" ? targetLang : "bn",
    timings: { stt_ms: 0, llm_ms: 0, tts_ms: 0, total_ms: 0 },
  }

  if (direction === "outgoing") {
    return {
      ...base,
      transcript: "হ্যালো। আমরা আগামী মাসের ১৫ তারিখের মধ্যে প্রজেক্ট শেষ করার পরিকল্পনা করছি।",
      detected_lang: "bn",
      translated_text: OUTGOING_TRANSLATIONS[targetLang],
      analysis: "",
    }
  }

  return {
    ...base,
    transcript: "When do you expect the project timeline to be completed?",
    detected_lang: "en",
    translated_text: "প্রজেক্টের টাইমলাইন কবে নাগাদ শেষ হবে বলে আশা করছেন?",
    analysis: "ক্লায়েন্ট ডেলিভারির সময়সীমা জানতে চাইছেন।\n• আগামী মাসের ১৫ তারিখের কথা বলুন\n• মাইলস্টোনগুলো সংক্ষেপে জানান",
  }
}
