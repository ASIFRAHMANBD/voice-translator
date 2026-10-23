// Runs in the extension's ISOLATED world, before bridge.js. Reads Meet's own live
// captions (much more accurate than Whisper for Japanese/English) and reports each
// finished sentence. Meet's class names are obfuscated and change over time, so
// all selectors live here; if captions stop arriving, update SELECTORS.
;(() => {
  const SELECTORS = {
    region: '[role="region"].vNKgIf.UDinHf',
    regionFallback: '[role="region"][aria-label*="aption" i]',
    entry: ".nMcdL",
    speaker: ".NWpY1d",
    text: ".ygicle",
  }
  // Meet labels the local user's own captions with "You" in the UI language.
  const SELF_NAMES = new Set(["you", "あなた", "আপনি", "du", "vous", "tú", "你", "您"])
  const REGION_POLL_MS = 1000
  const SCAN_DEBOUNCE_MS = 80
  // Meet keeps revising the last words for a moment, so wait a little longer
  // than the speaker's pause before treating unpunctuated text as final.
  const CAPTION_SETTLE_MS = 300
  // Once Meet ends a sentence with punctuation and leaves it unchanged this long,
  // send it, even if the speaker is still talking.
  const SENTENCE_SETTLE_MS = 350
  // Shorter sentences wait for the pause instead, so "Mr." or "OK." isn't sent alone.
  // Japanese and Chinese characters carry more per character.
  const MIN_EARLY_SENTENCE_CHARS = 8
  const MIN_EARLY_SENTENCE_CHARS_CJK = 4
  const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u
  const MAX_PENDING_CHARS = 350
  // Anchor lengths count letters and digits only, so 8 is about two words.
  const MIN_ANCHOR_CHARS = 8
  const MAX_ANCHOR_CHARS = 48

  const LEADING_PUNCTUATION = /^[\s.,!?;:…。、，．！？：；」』）)\]]+/u
  const SENTENCE_END = /[。！？!?]+[」』）)]?|\.(?=\s|$)/gu
  const ABBREVIATION = /\b(?:mr|mrs|ms|dr|prof|st|vs|etc|inc|ltd|co|jr|sr|no|e\.g|i\.e)$/i

  const hasWords = (text) => /[\p{Letter}\p{Number}]/u.test(text)

  // Letters and digits only, lowercased, with each one's end offset in the original text,
  // so Meet adding punctuation or capitals to earlier words doesn't break matching.
  const normalize = (text) => {
    const chars = []
    const ends = []
    for (const match of text.matchAll(/[\p{Letter}\p{Number}]/gu)) {
      const lower = match[0].toLowerCase()
      chars.push(lower.length === 1 ? lower : match[0])
      ends.push(match.index + match[0].length)
    }
    return { text: chars.join(""), ends }
  }

  // Meet appends to one block per speaker, revises recent words, and trims the block's
  // start once it grows long. Find where the already-sent text ends inside the block.
  const findSentEnd = (raw, sent) => {
    if (!sent) return 0
    if (raw.startsWith(sent)) return sent.length
    const current = normalize(raw)
    const previous = normalize(sent).text
    if (!previous) return 0
    if (current.text.startsWith(previous)) return current.ends[previous.length - 1]
    const maxLength = Math.min(previous.length, MAX_ANCHOR_CHARS)
    for (let length = maxLength; length >= MIN_ANCHOR_CHARS; length--) {
      const index = current.text.lastIndexOf(previous.slice(-length))
      if (index >= 0) return current.ends[index + length - 1]
    }
    return null
  }

  // End offset of the last finished sentence in the text, or 0 if there is none.
  const lastSentenceEnd = (text) => {
    let end = 0
    for (const match of text.matchAll(SENTENCE_END)) {
      if (match[0] === "." && ABBREVIATION.test(text.slice(0, match.index))) continue
      end = match.index + match[0].length
    }
    return end
  }

  const createCaptionWatcher = ({ onUtterance, onActivity, onAvailability, onPending, settleMs }) => {
    const entries = new WeakMap()
    const active = new Set()
    let region = null
    let observer = null
    let pollTimer = null
    let scanTimer = null
    let available = null

    const entryState = (element) => {
      let state = entries.get(element)
      if (!state) {
        state = { sent: "", raw: "", speaker: "", timer: null, sentenceTimer: null, sentence: "" }
        entries.set(element, state)
      }
      return state
    }

    // Where the unsent text starts in the block, and the text itself.
    const pendingRange = (state) => {
      const end = findSentEnd(state.raw, state.sent)
      // Text was rewritten beyond recognition: resend only its tail, not the whole block.
      let start = end === null ? Math.max(0, state.raw.length - MAX_PENDING_CHARS) : end
      // Punctuation Meet added after the last sent word belongs to the sent text.
      start += state.raw.slice(start).match(LEADING_PUNCTUATION)?.[0].length || 0
      return { start, text: state.raw.slice(start).trimEnd() }
    }

    const clearTimers = (state) => {
      clearTimeout(state.timer)
      clearTimeout(state.sentenceTimer)
      state.timer = null
      state.sentenceTimer = null
      state.sentence = ""
    }

    const send = (state, text) => {
      if (hasWords(text)) onUtterance(state.speaker, text)
    }

    const flush = (element) => {
      const state = entries.get(element)
      if (!state) return
      clearTimers(state)
      active.delete(element)
      const { text } = pendingRange(state)
      state.sent = state.raw
      if (active.size === 0) {
        onActivity(false)
        onPending("", "")
      }
      send(state, text)
    }

    // Sends the finished sentences and keeps listening to the rest.
    const flushSentences = (element) => {
      const state = entries.get(element)
      if (!state) return
      state.sentenceTimer = null
      state.sentence = ""
      const { start, text } = pendingRange(state)
      const end = lastSentenceEnd(text)
      if (end === 0) return
      if (end >= text.length) {
        flush(element)
        return
      }
      state.sent = state.raw.slice(0, start + end)
      send(state, text.slice(0, end).trim())
      onPending(state.speaker, pendingRange(state).text)
    }

    // Speakers are deliberately independent: a second voice starting must not cut the first
    // speaker's unfinished sentence in half. Each caption block settles on its own timers.

    const isLongEnough = (sentence) =>
      normalize(sentence).text.length >= (CJK.test(sentence) ? MIN_EARLY_SENTENCE_CHARS_CJK : MIN_EARLY_SENTENCE_CHARS)

    const scheduleSentence = (element, state, text) => {
      const end = lastSentenceEnd(text)
      const sentence = end > 0 && isLongEnough(text.slice(0, end)) ? text.slice(0, end) : ""
      // Only a change in the finished part restarts the wait; new words after it don't.
      if (sentence === state.sentence) return
      clearTimeout(state.sentenceTimer)
      state.sentenceTimer = null
      state.sentence = sentence
      if (sentence) state.sentenceTimer = setTimeout(() => flushSentences(element), SENTENCE_SETTLE_MS)
    }

    const handleEntry = (element) => {
      const speaker = element.querySelector(SELECTORS.speaker)?.textContent?.trim() || ""
      const raw = element.querySelector(SELECTORS.text)?.textContent?.trim() || ""
      if (!raw || SELF_NAMES.has(speaker.toLowerCase())) return

      const state = entryState(element)
      if (raw === state.raw && speaker === state.speaker) return
      const isFirstSighting = !state.raw
      state.raw = raw
      state.speaker = speaker
      // Captions already on screen when listening starts were said before; skip them.
      if (isFirstSighting && !watcher.listening) {
        state.sent = raw
        return
      }

      const { text } = pendingRange(state)
      if (!hasWords(text)) return
      active.add(element)
      onActivity(true)
      onPending(speaker, text)
      if (text.length >= MAX_PENDING_CHARS) {
        flush(element)
        return
      }
      clearTimeout(state.timer)
      state.timer = setTimeout(() => flush(element), settleMs())
      scheduleSentence(element, state, text)
    }

    const scan = () => {
      scanTimer = null
      if (!region) return
      region.querySelectorAll(SELECTORS.entry).forEach(handleEntry)
    }

    const scheduleScan = () => {
      if (scanTimer) return
      scanTimer = setTimeout(scan, SCAN_DEBOUNCE_MS)
    }

    const setAvailable = (value) => {
      if (available === value) return
      available = value
      onAvailability(value)
    }

    const attach = () => {
      const found = document.querySelector(SELECTORS.region) || document.querySelector(SELECTORS.regionFallback)
      if (found === region && region?.isConnected) return
      observer?.disconnect()
      observer = null
      ;[...active].forEach(flush)
      region = found
      setAvailable(Boolean(region))
      if (!region) return
      observer = new MutationObserver(scheduleScan)
      observer.observe(region, { childList: true, subtree: true, characterData: true })
      scan()
    }

    const watcher = {
      listening: false,
      start: () => {
        // Mark what is already on screen as sent before listening begins.
        watcher.listening = false
        available = null
        attach()
        scan()
        clearTimeout(scanTimer)
        scanTimer = null
        watcher.listening = true
        pollTimer = setInterval(attach, REGION_POLL_MS)
      },
      stop: () => {
        clearInterval(pollTimer)
        pollTimer = null
        clearTimeout(scanTimer)
        scanTimer = null
        ;[...active].forEach(flush)
        observer?.disconnect()
        observer = null
        region = null
        watcher.listening = false
      },
    }
    return watcher
  }

  window.__meetAiCaptions = { createCaptionWatcher, settleDelayMs: CAPTION_SETTLE_MS }
})()
