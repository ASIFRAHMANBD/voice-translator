// Runs in the extension's ISOLATED world. Owns the HUD, relays recorded clips to
// the service worker, and sends playback back to inject.js. The DOM is built with
// createElement/textContent only: Meet enforces Trusted Types, so innerHTML throws.
;(() => {
  if (document.getElementById("meet-ai-hud")) return

  const SOURCE = "meet-ai"
  const MAX_ENTRIES = 30
  const MAX_CONTEXT_TURNS = 6
  const SpeechRecognitionApi = window.SpeechRecognition || window.webkitSpeechRecognition
  // realtime = OpenAI live interpreter: translates while you speak (hands-free only).
  const ENGINES = ["realtime", "google", "whisper"]
  const DEFAULT_ENGINE = "realtime"
  // New storage key: older versions saved "whisper" as the default, which would
  // otherwise keep everyone off the live interpreter.
  const ENGINE_STORAGE_KEY = "banglaEngineV2"
  const BANGLA_LOCALE = "bn-BD"
  // Chrome ends recognition sessions on its own (silence, ~1 min cap); restart
  // them, but give up if they keep ending instantly (offline, blocked).
  const MAX_QUICK_RESTARTS = 5
  const QUICK_END_MS = 1000
  // Chrome finalizes a long sentence in several pieces at short pauses. Pieces are
  // joined until the speaker has been quiet for the pause setting (Chrome has
  // already waited part of it before finalizing), so one sentence = one request.
  const CHROME_FINALIZE_DELAY_MS = 300
  const MIN_MERGE_WINDOW_MS = 200
  const MAX_UTTERANCE_CHARS = 400
  const FATAL_SPEECH_ERRORS = {
    "not-allowed": "Chrome blocked speech recognition. Allow the microphone for meet.google.com, or choose Whisper in Settings.",
    "service-not-allowed": "Chrome's speech service is not available. Choose Whisper in Settings.",
    "audio-capture": "No microphone found for speech recognition.",
    "language-not-supported": "Chrome can't recognize Bangla here. Choose Whisper in Settings.",
  }
  const DEFAULT_BACKEND_URL = "http://localhost:3000"
  // Cutting a sentence at very short pauses split words in half and lost them;
  // 0.6 s keeps whole phrases together.
  const DEFAULT_SILENCE_MS = 600
  const DIRECTIONS = ["outgoing", "incoming"]
  const MODES = ["vad", "ptt"]
  const PAUSE_OPTIONS = [
    { value: 450, label: "0.45 s (fast talkers)" },
    { value: 600, label: "0.6 s (recommended)" },
    { value: 900, label: "0.9 s (long pauses while thinking)" },
  ]

  // Live interpreter (OpenAI realtime translation)
  const REALTIME_PORT_NAME = "realtime-translate"
  // A translation card is closed after this much quiet, so each thought gets its own card.
  const LIVE_ENTRY_IDLE_MS = 2500
  const LIVE_ENTRY_MAX_CHARS = 400
  // After stop, wait this long for the last words before giving up.
  const REALTIME_STOP_FALLBACK_MS = 600
  const REALTIME_CLOSE_TIMEOUT_MS = 10_000

  const VOICE_RATES = [
    { value: 0.85, label: "Slower" },
    { value: 0.95, label: "Slightly slower" },
    { value: 1, label: "Normal" },
    { value: 1.1, label: "Faster" },
  ]
  const DEFAULT_VOICE_RATE = 1
  // live = OpenAI live transcription of the meeting audio (auto Japanese/English).
  const CLIENT_SOURCES = ["live", "captions", "whisper"]
  const Captions = window.__meetAiCaptions
  const DEFAULT_CLIENT_SOURCE = "live"
  // New key so the new default reaches people who saved "captions" before.
  const CLIENT_SOURCE_STORAGE_KEY = "clientSourceV2"
  const CLIENT_LIVE_PORT_NAME = "realtime-transcribe"
  // Captions missing this long after starting most likely means CC is off.
  const CAPTIONS_MISSING_WARN_MS = 3000
  const MAX_HISTORY_TURNS = 300

  const LANG_LABELS = { ja: "Japanese", en: "English", bn: "Bangla" }

  const BUTTON_COPY = {
    outgoing: {
      shortcut: "Alt+B",
      ptt: { idle: "Speak Bangla", recording: "Stop and translate", processing: "Translating…" },
      vad: { idle: "Start live: my Bangla", live: "Live · listening to you", speech: "Live · hearing you…" },
      stopLabel: "Stop live translation of your Bangla",
    },
    incoming: {
      shortcut: "Alt+L",
      ptt: { idle: "Listen to client", recording: "Stop and translate", processing: "Translating…" },
      vad: { idle: "Start live: client", live: "Live · listening to client", speech: "Live · client speaking…" },
      stopLabel: "Stop live translation of the client",
    },
  }

  const MODE_HINTS = {
    vad: "Speak naturally. The live interpreter translates while you are still talking.",
    vadSentence: "Speak naturally. Each sentence is translated as soon as you pause.",
    ptt: "Press to start recording, press again to translate.",
  }

  const createDirectionState = () => ({
    status: "idle",
    speaking: false,
    pending: 0,
    chain: Promise.resolve(),
    failedClip: null,
  })

  const state = {
    targetLang: "ja",
    mode: "vad",
    silenceMs: DEFAULT_SILENCE_MS,
    micReady: false,
    micMuted: false,
    collapsed: false,
    speakBangla: true,
    voiceRate: DEFAULT_VOICE_RATE,
    engine: DEFAULT_ENGINE,
    clientSource: DEFAULT_CLIENT_SOURCE,
    speech: null,
    captions: null,
    realtime: null,
    clientLive: null,
    // With headphones the client's Bangla voice can't leak into the mic, so we
    // keep listening to the host while it plays.
    headphones: true,
    incomingPlaying: false,
    recentTurns: [],
    history: [],
    summary: { status: "idle", text: "" },
    directions: { outgoing: createDirectionState(), incoming: createDirectionState() },
    retryDirection: null,
  }

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------
  const el = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag)
    Object.entries(attrs).forEach(([key, value]) => {
      if (value === undefined || value === null || value === false) return
      if (key === "className") node.className = value
      else if (key === "text") node.textContent = value
      else node.setAttribute(key, value === true ? "" : String(value))
    })
    children.forEach((child) => child && node.append(child))
    return node
  }

  const postToInject = (type, payload = {}) => {
    window.postMessage({ source: SOURCE, target: "inject", type, ...payload }, window.location.origin)
  }

  const arrayBufferToBase64 = (buffer) => {
    const bytes = new Uint8Array(buffer)
    const chunkSize = 0x8000
    let binary = ""
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize))
    }
    return btoa(binary)
  }

  const storageGet = (keys) =>
    new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (result) => resolve(result || {}))
      } catch {
        resolve({})
      }
    })

  const storageSet = (values) => {
    try {
      chrome.storage.local.set(values)
    } catch {
      // Extension context invalidated after a reload; nothing to persist into.
    }
  }

  const isActive = (direction) => {
    const { status } = state.directions[direction]
    return status === "live" || status === "recording" || status === "processing"
  }

  const anyActive = () => DIRECTIONS.some(isActive)

  // ---------------------------------------------------------------------------
  // HUD
  // ---------------------------------------------------------------------------
  const ui = {}

  const buildActionButton = (direction) => {
    const copy = BUTTON_COPY[direction]
    const label = el("span", { className: "mai-btn-label" })
    const kbd = el("kbd", { className: "mai-kbd", text: copy.shortcut })
    const button = el(
      "button",
      {
        type: "button",
        className: `mai-btn mai-btn-${direction}`,
        "aria-pressed": "false",
        "aria-keyshortcuts": copy.shortcut,
        "data-state": "idle",
      },
      [el("span", { className: "mai-spinner", "aria-hidden": "true" }), label, kbd]
    )
    button.addEventListener("click", () => handleToggle(direction))
    return { button, label }
  }

  const buildModeSwitch = () => {
    const options = [
      { value: "vad", text: "Hands-free" },
      { value: "ptt", text: "Push-to-talk" },
    ]
    const radios = {}
    const labels = options.map(({ value, text }) => {
      const input = el("input", { type: "radio", name: "mai-mode", value, className: "mai-segment-input" })
      input.addEventListener("change", handleModeChange)
      radios[value] = input
      return el("label", { className: "mai-segment" }, [input, el("span", { text })])
    })
    const hint = el("p", { className: "mai-hint", id: "mai-mode-hint" })
    const fieldset = el("fieldset", { className: "mai-mode", "aria-describedby": "mai-mode-hint" }, [
      el("legend", { className: "mai-visually-hidden", text: "Translation mode" }),
      el("div", { className: "mai-segments" }, labels),
    ])
    return { fieldset, radios, hint }
  }

  const buildHud = () => {
    const title = el("h2", { className: "mai-title", id: "mai-title", text: "AI Interpreter" })

    const langLabel = el("label", { className: "mai-visually-hidden", for: "mai-lang", text: "Translate my Bangla into" })
    const langSelect = el("select", { id: "mai-lang", className: "mai-select" }, [
      el("option", { value: "ja", text: "BN → Japanese" }),
      el("option", { value: "en", text: "BN → English" }),
    ])
    langSelect.addEventListener("change", handleLangChange)

    const collapseBtn = el("button", {
      type: "button",
      className: "mai-icon-btn",
      "aria-expanded": "true",
      "aria-controls": "mai-body",
      "aria-label": "Collapse interpreter panel",
      title: "Collapse",
      text: "–",
    })
    collapseBtn.addEventListener("click", handleCollapseToggle)

    const header = el("div", { className: "mai-header" }, [
      el("span", { className: "mai-grip", "aria-hidden": "true", text: "⋮⋮" }),
      title,
      langLabel,
      langSelect,
      collapseBtn,
    ])

    const mic = el("p", { className: "mai-mic", "data-ready": "false" })
    const modeSwitch = buildModeSwitch()

    const speak = buildActionButton("outgoing")
    const listen = buildActionButton("incoming")
    const conversation = buildConversationButton()

    // Not live regions: interim text changes several times a second.
    const buildInterim = (direction) => {
      const label = el("span", { className: "mai-interim-label" })
      const text = el("span", { className: "mai-interim-text", lang: direction === "outgoing" ? "bn" : "" })
      const line = el("p", { className: "mai-interim", "data-direction": direction, hidden: true }, [label, text])
      return { line, label, text }
    }
    const interim = { outgoing: buildInterim("outgoing"), incoming: buildInterim("incoming") }

    const statusText = el("span", { className: "mai-status-text", text: "Ready" })
    const retryBtn = el("button", { type: "button", className: "mai-link-btn", hidden: true, text: "Retry" })
    retryBtn.addEventListener("click", handleRetry)
    const status = el("div", { className: "mai-status", role: "status", "aria-live": "polite", "data-tone": "neutral" }, [
      statusText,
      retryBtn,
    ])

    const emptyState = el("p", {
      className: "mai-empty",
      text: "Nothing translated yet. Start live mode, or press a button while someone speaks.",
    })
    const log = el("div", {
      className: "mai-log",
      tabindex: "0",
      role: "log",
      "aria-label": "Translations and analysis",
    }, [emptyState])

    const summary = buildSummary()
    const settings = buildSettings()

    const body = el("div", { id: "mai-body", className: "mai-body" }, [
      mic,
      modeSwitch.fieldset,
      modeSwitch.hint,
      el("div", { className: "mai-actions" }, [conversation.button, speak.button, listen.button]),
      interim.outgoing.line,
      interim.incoming.line,
      status,
      log,
      summary,
      settings,
    ])

    const panel = el("section", { id: "meet-ai-hud", "aria-labelledby": "mai-title", "data-collapsed": "false" }, [
      header,
      body,
    ])

    Object.assign(ui, {
      panel, header, body, langSelect, collapseBtn, mic, interim, status, statusText, retryBtn, log, emptyState,
      modeFieldset: modeSwitch.fieldset,
      modeRadios: modeSwitch.radios,
      modeHint: modeSwitch.hint,
      buttons: { outgoing: speak, incoming: listen },
      conversation,
    })

    enableDragging(panel, header)
    document.body.append(panel)
  }

  // Starts/stops both directions together: your Bangla out, the client's words in.
  const buildConversationButton = () => {
    const label = el("span", { className: "mai-btn-label" })
    const button = el(
      "button",
      {
        type: "button",
        className: "mai-btn mai-btn-conversation",
        "aria-pressed": "false",
        "aria-keyshortcuts": "Alt+C",
        "data-state": "idle",
      },
      [el("span", { className: "mai-spinner", "aria-hidden": "true" }), label, el("kbd", { className: "mai-kbd", text: "Alt+C" })]
    )
    button.addEventListener("click", handleConversationToggle)
    return { button, label }
  }

  const buildSummary = () => {
    const summaryBtn = el("button", {
      type: "button",
      className: "mai-btn mai-btn-secondary mai-btn-block",
      "aria-describedby": "mai-summary-hint",
      text: "Summarize meeting",
    })
    summaryBtn.addEventListener("click", handleSummarize)
    const hint = el("p", { className: "mai-hint", id: "mai-summary-hint" })

    const text = el("p", { className: "mai-summary-text", tabindex: "0", "aria-label": "Meeting summary text" })
    const feedback = el("p", { className: "mai-settings-feedback", "aria-live": "polite" })
    const copyBtn = el("button", { type: "button", className: "mai-btn mai-btn-secondary", text: "Copy" })
    const downloadBtn = el("button", { type: "button", className: "mai-btn mai-btn-secondary", text: "Download" })
    const closeBtn = el("button", { type: "button", className: "mai-link-btn", text: "Close" })
    copyBtn.addEventListener("click", handleSummaryCopy)
    downloadBtn.addEventListener("click", handleSummaryDownload)
    closeBtn.addEventListener("click", handleSummaryClose)

    const result = el("section", { className: "mai-summary-result", "aria-labelledby": "mai-summary-title", hidden: true }, [
      el("h3", { className: "mai-summary-title", id: "mai-summary-title", text: "Meeting summary" }),
      text,
      el("div", { className: "mai-settings-row" }, [copyBtn, downloadBtn, closeBtn, feedback]),
    ])

    Object.assign(ui, { summaryBtn, summaryHint: hint, summaryResult: result, summaryText: text, summaryFeedback: feedback })
    return el("div", { className: "mai-summary" }, [summaryBtn, hint, result])
  }

  const buildSettings = () => {
    const voiceRateSelect = el(
      "select",
      { id: "mai-voice-rate", className: "mai-select mai-select-block", "aria-describedby": "mai-voice-rate-hint" },
      VOICE_RATES.map(({ value, label }) => el("option", { value: String(value), text: label }))
    )
    voiceRateSelect.addEventListener("change", handleVoiceRateChange)
    ui.voiceRateSelect = voiceRateSelect

    const clientSourceSelect = el(
      "select",
      { id: "mai-client-source", className: "mai-select mai-select-block", "aria-describedby": "mai-client-source-hint" },
      [
        el("option", { value: "live", text: "OpenAI live (Japanese or English, auto-detect, recommended)" }),
        el("option", { value: "captions", text: "Meet captions (set CC to the client's language)", disabled: !Captions }),
        el("option", { value: "whisper", text: "OpenAI sentence by sentence (meeting audio)" }),
      ]
    )
    clientSourceSelect.addEventListener("change", handleClientSourceChange)
    ui.clientSourceSelect = clientSourceSelect

    const pauseSelect = el(
      "select",
      { id: "mai-pause", className: "mai-select mai-select-block" },
      PAUSE_OPTIONS.map(({ value, label }) => el("option", { value: String(value), text: label }))
    )
    pauseSelect.addEventListener("change", handlePauseChange)
    ui.pauseSelect = pauseSelect

    const engineSelect = el("select", { id: "mai-engine", className: "mai-select mai-select-block", "aria-describedby": "mai-engine-hint" }, [
      el("option", { value: "realtime", text: "OpenAI live interpreter (simultaneous, recommended)" }),
      el("option", { value: "google", text: "Google (built into Chrome)", disabled: !SpeechRecognitionApi }),
      el("option", { value: "whisper", text: "OpenAI sentence by sentence (gpt-transcribe)" }),
    ])
    engineSelect.addEventListener("change", handleEngineChange)
    ui.engineSelect = engineSelect

    const headphonesInput = el("input", { id: "mai-headphones", type: "checkbox", "aria-describedby": "mai-headphones-hint" })
    headphonesInput.addEventListener("change", handleHeadphonesChange)
    ui.headphonesInput = headphonesInput

    const speakBanglaInput = el("input", { id: "mai-speak-bangla", type: "checkbox", "aria-describedby": "mai-speak-bangla-hint" })
    speakBanglaInput.addEventListener("change", handleSpeakBanglaChange)
    ui.speakBanglaInput = speakBanglaInput

    const urlInput = el("input", {
      id: "mai-backend-url",
      className: "mai-input",
      type: "url",
      inputmode: "url",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: DEFAULT_BACKEND_URL,
    })
    const tokenInput = el("input", {
      id: "mai-api-token",
      className: "mai-input",
      type: "password",
      autocomplete: "off",
      placeholder: "Optional",
    })
    const feedback = el("p", { className: "mai-settings-feedback", "aria-live": "polite" })
    const saveBtn = el("button", { type: "submit", className: "mai-btn mai-btn-secondary", text: "Save" })

    const form = el("form", { className: "mai-settings-form", novalidate: true }, [
      el("label", { for: "mai-pause", className: "mai-field-label", text: "Hands-free: send after a pause of" }),
      pauseSelect,
      el("p", { className: "mai-hint", text: "Applies the next time you start live mode." }),
      el("label", { for: "mai-engine", className: "mai-field-label", text: "Translate my Bangla with" }),
      engineSelect,
      el("p", {
        className: "mai-hint",
        id: "mai-engine-hint",
        text: "Live interpreter: the client hears the translation while you are still talking (hands-free; about $0.03 per minute). Push-to-talk always uses gpt-transcribe. Applies the next time you start.",
      }),
      el("label", { className: "mai-check", for: "mai-headphones" }, [
        headphonesInput,
        el("span", { text: "I'm using headphones" }),
      ]),
      el("p", {
        className: "mai-hint",
        id: "mai-headphones-hint",
        text: "Keeps listening to you while the client's Bangla plays. Turn off when using speakers, so their voice isn't translated back to them.",
      }),
      el("label", { for: "mai-client-source", className: "mai-field-label", text: "Get the client's words from" }),
      clientSourceSelect,
      el("p", {
        className: "mai-hint",
        id: "mai-client-source-hint",
        text: "OpenAI live: hears the meeting audio, works out per sentence whether the client speaks Japanese or English, and translates each sentence into Bangla as soon as it ends. Captions need CC on, set to one language. Hands-free only; push-to-talk records a clip.",
      }),
      el("label", { for: "mai-voice-rate", className: "mai-field-label", text: "Voice speed" }),
      voiceRateSelect,
      el("p", {
        className: "mai-hint",
        id: "mai-voice-rate-hint",
        text: "For both the client's Japanese/English voice and your Bangla voice.",
      }),
      el("label", { className: "mai-check", for: "mai-speak-bangla" }, [
        speakBanglaInput,
        el("span", { text: "Read the client's words aloud in Bangla" }),
      ]),
      el("p", {
        className: "mai-hint",
        id: "mai-speak-bangla-hint",
        text: "Turn off to get text only, about 1 second faster.",
      }),
      el("label", { for: "mai-backend-url", className: "mai-field-label", text: "Backend URL" }),
      urlInput,
      el("label", { for: "mai-api-token", className: "mai-field-label", text: "API token" }),
      tokenInput,
      el("div", { className: "mai-settings-row" }, [saveBtn, feedback]),
    ])

    form.addEventListener("submit", (event) => {
      event.preventDefault()
      const rawUrl = urlInput.value.trim() || DEFAULT_BACKEND_URL
      let parsed = null
      try {
        parsed = new URL(rawUrl)
      } catch {
        parsed = null
      }
      if (!parsed || !["http:", "https:"].includes(parsed.protocol)) {
        feedback.textContent = "Enter a full http:// or https:// URL."
        feedback.dataset.tone = "error"
        urlInput.setAttribute("aria-invalid", "true")
        urlInput.focus()
        return
      }
      urlInput.removeAttribute("aria-invalid")
      const backendUrl = parsed.origin + parsed.pathname.replace(/\/+$/, "")
      urlInput.value = backendUrl
      storageSet({ backendUrl, apiToken: tokenInput.value.trim() })
      feedback.textContent = "Saved."
      feedback.dataset.tone = "success"
    })

    storageGet(["backendUrl", "apiToken"]).then(({ backendUrl, apiToken }) => {
      urlInput.value = backendUrl || DEFAULT_BACKEND_URL
      tokenInput.value = apiToken || ""
    })

    return el("details", { className: "mai-settings" }, [
      el("summary", { className: "mai-settings-summary", text: "Settings" }),
      form,
    ])
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  const getButtonLabel = (direction) => {
    const { status, speaking } = state.directions[direction]
    const copy = BUTTON_COPY[direction]
    if (status === "live") return speaking ? copy.vad.speech : copy.vad.live
    if (status === "recording") return copy.ptt.recording
    if (status === "processing") return copy.ptt.processing
    return copy[state.mode].idle
  }

  const renderButton = (direction) => {
    const { button, label } = ui.buttons[direction]
    const { status, speaking } = state.directions[direction]
    const isOn = status === "recording" || status === "live"
    const isProcessing = status === "processing"

    button.dataset.state = status
    button.dataset.speaking = String(status === "live" && speaking)
    button.setAttribute("aria-pressed", String(isOn))
    button.disabled = isProcessing
    if (isProcessing) button.setAttribute("aria-busy", "true")
    else button.removeAttribute("aria-busy")
    if (status === "live") button.setAttribute("aria-label", BUTTON_COPY[direction].stopLabel)
    else button.removeAttribute("aria-label")

    label.textContent = getButtonLabel(direction)
  }

  const renderModeSwitch = () => {
    const locked = anyActive()
    MODES.forEach((mode) => {
      ui.modeRadios[mode].checked = state.mode === mode
      ui.modeRadios[mode].disabled = locked
    })
    const hint = state.mode === "vad" && state.engine !== "realtime" ? MODE_HINTS.vadSentence : MODE_HINTS[state.mode]
    ui.modeHint.textContent = locked ? `${hint} Stop to switch mode.` : hint
  }

  const renderConversationButton = () => {
    const { button, label } = ui.conversation
    button.hidden = state.mode !== "vad"
    const live = DIRECTIONS.filter((direction) => state.directions[direction].status === "live")
    const busy = DIRECTIONS.some((direction) => state.directions[direction].status === "processing")
    const allOn = live.length === DIRECTIONS.length
    button.dataset.state = allOn ? "live" : "idle"
    button.dataset.speaking = String(allOn && DIRECTIONS.some((direction) => state.directions[direction].speaking))
    button.setAttribute("aria-pressed", String(allOn))
    button.disabled = busy
    label.textContent = allOn ? "Stop conversation" : live.length > 0 ? "Start both ways" : "Start conversation (both ways)"
  }

  const renderAll = () => {
    DIRECTIONS.forEach(renderButton)
    renderConversationButton()
    renderModeSwitch()
  }

  const setStatus = (message, tone = "neutral", retryDirection = null) => {
    ui.statusText.textContent = message
    ui.status.dataset.tone = tone
    state.retryDirection = retryDirection
    ui.retryBtn.hidden = !retryDirection
  }

  const setDirectionStatus = (direction, status) => {
    const directionState = state.directions[direction]
    directionState.status = status
    if (status !== "live") directionState.speaking = false
    renderAll()
  }

  const renderMic = () => {
    ui.mic.dataset.ready = state.micReady ? (state.micMuted ? "muted" : "true") : "false"
    if (!state.micReady) ui.mic.textContent = "Mic off: turn on your Meet microphone"
    else if (state.micMuted) ui.mic.textContent = "Meet mic is muted: unmute it so the client hears the translation"
    else ui.mic.textContent = "Mic connected (virtual mic active)"
  }

  const describeLiveIdle = () => {
    const pending = DIRECTIONS.reduce((sum, direction) => sum + state.directions[direction].pending, 0)
    if (pending > 0) return { message: `Translating… (${pending} in progress)`, tone: "neutral" }
    const liveDirections = DIRECTIONS.filter((direction) => state.directions[direction].status === "live")
    if (liveDirections.length === 0) return { message: "Ready", tone: "neutral" }
    const who = liveDirections
      .map((direction) => {
        if (direction !== "outgoing") return state.clientLive ? "the client (Japanese/English auto)" : "the client"
        return state.realtime ? `you (simultaneous → ${LANG_LABELS[state.realtime.targetLang]})` : "you"
      })
      .join(" and ")
    return { message: `Live: listening to ${who}.`, tone: "neutral" }
  }

  const refreshLiveStatus = () => {
    const { message, tone } = describeLiveIdle()
    setStatus(message, tone)
  }

  const addEntry = (direction, data) => {
    if (ui.emptyState.isConnected) ui.emptyState.remove()

    const isOutgoing = direction === "outgoing"
    const sourceLang = isOutgoing ? "bn" : data.detected_lang
    const targetLang = isOutgoing ? data.target_lang || state.targetLang : "bn"
    const sourceLabel = LANG_LABELS[sourceLang] || (sourceLang ? sourceLang.toUpperCase() : "Auto")
    const targetLabel = LANG_LABELS[targetLang] || targetLang.toUpperCase()
    const who = isOutgoing ? "You" : data.speaker_name ? `Client (${data.speaker_name})` : "Client"

    const children = [
      el("p", { className: "mai-entry-meta", text: `${who} · ${sourceLabel} → ${targetLabel}` }),
    ]
    if (data.transcript) children.push(el("p", { className: "mai-entry-source", lang: sourceLang || undefined, text: data.transcript }))
    if (data.understood && data.understood !== data.transcript) {
      children.push(
        el("p", { className: "mai-entry-understood", lang: sourceLang || undefined }, [
          el("span", { className: "mai-entry-understood-label", text: "Understood as: " }),
          data.understood,
        ])
      )
    }
    if (data.unclear) {
      children.push(
        el("p", {
          className: "mai-entry-unclear",
          text: isOutgoing ? "Couldn't understand this, so nothing was sent. Please say it again." : "Couldn't understand the client.",
        })
      )
    } else {
      children.push(el("p", { className: "mai-entry-translation", lang: targetLang, text: data.translated_text || "(no translation)" }))
    }
    if (data.analysis) {
      children.push(
        el("div", { className: "mai-entry-analysis" }, [
          el("p", { className: "mai-entry-analysis-label", text: "Analysis & suggested reply" }),
          el("p", { className: "mai-entry-analysis-text", lang: "bn", text: data.analysis }),
        ])
      )
    }

    const entry = el("article", { className: `mai-entry mai-entry-${direction}` }, children)
    appendToLog(entry)
  }

  const isLogPinnedToBottom = () => ui.log.scrollHeight - ui.log.scrollTop - ui.log.clientHeight < 24

  const appendToLog = (entry) => {
    if (ui.emptyState.isConnected) ui.emptyState.remove()
    const pinnedToBottom = isLogPinnedToBottom()
    ui.log.append(entry)
    while (ui.log.children.length > MAX_ENTRIES) ui.log.firstElementChild.remove()
    if (pinnedToBottom) ui.log.scrollTop = ui.log.scrollHeight
  }

  // ---------------------------------------------------------------------------
  // Backend round-trip (via service worker)
  // ---------------------------------------------------------------------------
  const sendToBackground = (type, payload) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, payload }, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message })
            return
          }
          resolve(response || { ok: false, error: "No response from extension background." })
        })
      } catch {
        resolve({ ok: false, error: "Extension was reloaded. Refresh this Meet tab." })
      }
    })

  const sendToBackend = (clip) => sendToBackground("PROCESS_VOICE", clip)

  // The response carries audio for the first sentence only. The rest is requested
  // right away and queued in order behind it, so playback starts early and has no gaps
  // as long as each sentence is ready before the previous one finishes.
  const playRemainingSentences = async (direction, sentences, lang, voiceRate) => {
    const requests = sentences.map((text) => sendToBackground("SYNTHESIZE", { text, lang, voiceRate }))
    for (const request of requests) {
      const response = await request
      if (!response.ok || !response.data?.audio_base64) {
        setStatus(`Part of the voice failed: ${response.error || "no audio"}`, "warning", direction)
        return
      }
      postToInject("PLAY", { direction, audioBase64: response.data.audio_base64 })
    }
  }

  const recordHistory = (direction, data, clip) => {
    state.history.push({
      speaker: direction === "outgoing" ? "host" : "client",
      name: clip.speakerName || "",
      text: (data.understood || data.transcript || "").trim(),
      translation: (data.translated_text || "").trim(),
    })
    if (state.history.length > MAX_HISTORY_TURNS) state.history.shift()
    renderSummaryButton()
  }

  // Resolves once every piece of audio for this clip has been queued for playback,
  // so the next clip in the live chain never jumps ahead of it.
  const deliverResponse = async (clip, response, isLive) => {
    const { direction } = clip
    const directionState = state.directions[direction]

    if (!response.ok) {
      directionState.failedClip = clip
      if (!isLive) setDirectionStatus(direction, "error")
      setStatus(`Couldn't translate: ${response.error}`, "error", direction)
      return
    }

    if (!isLive) setDirectionStatus(direction, "idle")
    const data = response.data || {}
    if (data.unclear) {
      addEntry(direction, { ...data, target_lang: clip.targetLang })
      setStatus(
        direction === "outgoing" ? "Didn't catch that. Nothing was sent; please repeat." : "Couldn't understand the client.",
        "warning"
      )
      return
    }

    rememberTurn(direction, data.understood || data.transcript)

    if (data.empty || !data.translated_text) {
      if (isLive) refreshLiveStatus()
      else setStatus("No speech detected in that clip. Try again a little closer to the mic.", "warning")
      return
    }

    addEntry(direction, { ...data, target_lang: clip.targetLang, speaker_name: clip.speakerName })
    recordHistory(direction, data, clip)
    if (!data.audio_base64) {
      if (data.voice_error && clip.speak) {
        directionState.failedClip = clip
        setStatus(
          direction === "outgoing"
            ? "Translated, but the voice service failed, so the client heard nothing."
            : "Translated, but the Bangla voice failed.",
          "warning",
          direction
        )
      } else if (isLive) refreshLiveStatus()
      else if (clip.speak) setStatus("Translated (no audio returned).", "warning")
      else setStatus("Translated (voice is off in Settings).", "success")
      return
    }
    postToInject("PLAY", { direction, audioBase64: data.audio_base64 })
    setStatus(
      direction === "outgoing"
        ? `Playing ${LANG_LABELS[clip.targetLang]} voice into the meeting…`
        : "Playing Bangla in your headphones…",
      "success"
    )
    const remaining = Array.isArray(data.remaining_sentences) ? data.remaining_sentences : []
    if (remaining.length > 0) {
      await playRemainingSentences(direction, remaining, data.voice_lang || (direction === "outgoing" ? clip.targetLang : "bn"), clip.voiceRate)
    }
  }

  // Recent transcripts give the translator context for pronouns and misheard words.
  const rememberTurn = (direction, transcript) => {
    const text = typeof transcript === "string" ? transcript.trim() : ""
    if (!text) return
    state.recentTurns.push({ speaker: direction === "outgoing" ? "host" : "client", text })
    if (state.recentTurns.length > MAX_CONTEXT_TURNS) state.recentTurns.shift()
  }

  const processClip = async (clip) => {
    setDirectionStatus(clip.direction, "processing")
    setStatus(clip.direction === "outgoing" ? "Translating your Bangla…" : "Translating client audio into Bangla…")
    const response = await sendToBackend(clip)
    await deliverResponse(clip, response, false)
  }

  // Requests run in parallel; results are shown and played in the order spoken.
  const enqueueLiveClip = (clip) => {
    const directionState = state.directions[clip.direction]
    directionState.pending += 1
    refreshLiveStatus()
    const responsePromise = sendToBackend(clip)
    directionState.chain = directionState.chain
      .then(() => responsePromise)
      .then((response) => {
        directionState.pending -= 1
        return deliverResponse(clip, response, true)
      })
      .catch((err) => {
        // Keep the chain alive for the next clip, but decrement pending.
        directionState.pending = Math.max(0, directionState.pending - 1)
        console.warn('[client live] enqueueLiveClip error (chain kept alive):', err?.message || err)
      })
  }

  // ---------------------------------------------------------------------------
  // Browser speech recognition for the host's Bangla (Google, built into Chrome)
  // ---------------------------------------------------------------------------
  const usesBrowserStt = (direction) => direction === "outgoing" && state.engine === "google" && Boolean(SpeechRecognitionApi)

  const buildTextClip = (text, direction = "outgoing", speakerName = "", lang = "") => ({
    direction,
    text,
    speakerName,
    lang,
    targetLang: state.targetLang,
    context: state.recentTurns.slice(),
    speak: direction === "outgoing" || state.speakBangla,
    voiceRate: state.voiceRate,
  })

  const renderInterim = (text, direction = "outgoing", speakerName = "") => {
    const { line, label, text: textNode } = ui.interim[direction]
    label.textContent = direction === "outgoing" ? "You" : speakerName ? `Client (${speakerName})` : "Client"
    textNode.textContent = text
    line.hidden = !text
  }

  const setSpeaking = (direction, speaking) => {
    const directionState = state.directions[direction]
    if (directionState.status !== "live" || directionState.speaking === speaking) return
    directionState.speaking = speaking
    renderButton(direction)
  }

  const setOutgoingSpeaking = (speaking) => setSpeaking("outgoing", speaking)

  const flushUtterance = (session, includeInterim = false) => {
    clearTimeout(session.flushTimer)
    session.flushTimer = null
    const text = [...session.finals, includeInterim ? session.interim : ""].join(" ").trim()
    session.finals = []
    if (includeInterim) session.interim = ""
    renderInterim(session.interim)
    if (!text) return

    if (state.micMuted) {
      setStatus("Meet mic is muted, so that sentence was not sent.", "warning")
      return
    }
    if (state.incomingPlaying && !state.headphones) {
      // Likely the client's Bangla voice leaking from speakers into the mic.
      setStatus("Not sent: heard while the client's Bangla was playing. Use headphones and say it again.", "warning")
      return
    }
    enqueueLiveClip(buildTextClip(text))
  }

  const scheduleFlush = (session) => {
    clearTimeout(session.flushTimer)
    const tooLong = session.finals.join(" ").length >= MAX_UTTERANCE_CHARS
    if (tooLong) {
      flushUtterance(session)
      return
    }
    session.flushTimer = setTimeout(() => flushUtterance(session), session.mergeWindowMs)
  }

  const handleSpeechResult = (session, event) => {
    let interim = ""
    let gotFinal = false
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i]
      const text = result[0].transcript.trim()
      if (!text) continue
      if (result.isFinal) {
        session.finals.push(text)
        gotFinal = true
      } else {
        interim = `${interim} ${text}`.trim()
      }
    }
    session.interim = interim
    renderInterim([...session.finals, interim].join(" ").trim())
    setOutgoingSpeaking(Boolean(interim))

    if (session.mode !== "vad") return
    if (interim) clearTimeout(session.flushTimer)
    else if (gotFinal || session.finals.length > 0) scheduleFlush(session)
  }

  const handleSpeechError = (session, event) => {
    const fatalMessage = FATAL_SPEECH_ERRORS[event.error]
    if (fatalMessage) {
      session.fatal = true
      setStatus(fatalMessage, "error")
      return
    }
    if (event.error === "network") setStatus("Can't reach Google speech recognition. Check your internet.", "error")
  }

  const finishBrowserStt = (session) => {
    state.speech = null
    renderInterim("")
    if (session.mode === "ptt" && !session.fatal) {
      const text = [...session.finals, session.interim].join(" ").trim()
      if (text) {
        processClip(buildTextClip(text))
        return
      }
      setDirectionStatus("outgoing", "idle")
      setStatus("No speech detected. Try again a little closer to the mic.", "warning")
      return
    }
    flushUtterance(session, true)
    setDirectionStatus("outgoing", "idle")
    if (!session.fatal && ui.status.dataset.tone !== "warning") refreshLiveStatus()
  }

  const handleSpeechEnd = (session) => {
    if (state.speech !== session) return
    const shouldRestart = session.mode === "vad" && !session.stopping && !session.fatal
    if (shouldRestart) {
      // Chrome discards unfinished words when a session ends; keep them so they
      // join the rest of the sentence after the restart.
      if (session.interim) {
        session.finals.push(session.interim)
        session.interim = ""
        scheduleFlush(session)
      }
      const endedQuickly = Date.now() - session.startedAt < QUICK_END_MS
      session.quickEnds = endedQuickly ? session.quickEnds + 1 : 0
      if (session.quickEnds < MAX_QUICK_RESTARTS) {
        try {
          session.startedAt = Date.now()
          session.recognition.start()
          return
        } catch {
          // fall through and stop
        }
      }
      session.fatal = true
      setStatus("Speech recognition keeps stopping. Check your internet, or choose Whisper in Settings.", "error")
    }
    finishBrowserStt(session)
  }

  const startBrowserStt = () => {
    const recognition = new SpeechRecognitionApi()
    recognition.lang = BANGLA_LOCALE
    recognition.continuous = true
    recognition.interimResults = true
    recognition.maxAlternatives = 1

    const session = {
      recognition,
      mode: state.mode,
      finals: [],
      interim: "",
      flushTimer: null,
      mergeWindowMs: Math.max(MIN_MERGE_WINDOW_MS, state.silenceMs - CHROME_FINALIZE_DELAY_MS),
      startedAt: Date.now(),
      quickEnds: 0,
      stopping: false,
      fatal: false,
    }
    recognition.onresult = (event) => handleSpeechResult(session, event)
    recognition.onerror = (event) => handleSpeechError(session, event)
    recognition.onend = () => handleSpeechEnd(session)

    try {
      recognition.start()
    } catch {
      setStatus("Couldn't start speech recognition. Choose Whisper in Settings.", "error")
      return
    }
    state.speech = session

    if (session.mode === "vad") {
      setDirectionStatus("outgoing", "live")
      refreshLiveStatus()
      return
    }
    setDirectionStatus("outgoing", "recording")
    setStatus("Listening to your Bangla. Press again when you finish.")
  }

  const stopBrowserStt = () => {
    const session = state.speech
    if (!session) return
    session.stopping = true
    // stop() (unlike abort()) still delivers the final result for the last words.
    session.recognition.stop()
  }

  // ---------------------------------------------------------------------------
  // Client speech from Meet's own captions (hands-free only)
  // ---------------------------------------------------------------------------
  const usesCaptions = (direction) =>
    direction === "incoming" && state.clientSource === "captions" && state.mode === "vad" && Boolean(Captions)

  const handleCaptionUtterance = (speakerName, text) => {
    enqueueLiveClip(buildTextClip(text.slice(0, 1000), "incoming", speakerName))
  }

  const handleCaptionAvailability = (session, available) => {
    clearTimeout(session.missingTimer)
    session.missingTimer = null
    if (available) {
      if (session.warned) refreshLiveStatus()
      session.warned = false
      return
    }
    session.missingTimer = setTimeout(() => {
      session.warned = true
      setStatus("No Meet captions found. Turn on captions (CC) in Meet, set to the client's language.", "warning")
    }, CAPTIONS_MISSING_WARN_MS)
  }

  const startCaptions = () => {
    const session = { watcher: null, missingTimer: null, warned: false }
    session.watcher = Captions.createCaptionWatcher({
      onUtterance: handleCaptionUtterance,
      onActivity: (speaking) => setSpeaking("incoming", speaking),
      onPending: (speakerName, text) => renderInterim(text, "incoming", speakerName),
      onAvailability: (available) => handleCaptionAvailability(session, available),
      settleMs: () => state.silenceMs + Captions.settleDelayMs,
    })
    state.captions = session
    setDirectionStatus("incoming", "live")
    refreshLiveStatus()
    session.watcher.start()
  }

  const stopCaptions = () => {
    const session = state.captions
    if (!session) return
    clearTimeout(session.missingTimer)
    session.watcher.stop()
    renderInterim("", "incoming")
    state.captions = null
    setDirectionStatus("incoming", "idle")
    refreshLiveStatus()
  }

  // ---------------------------------------------------------------------------
  // Client live transcription: streams meeting audio to Whisper, transcribes
  // Japanese or English on the fly, and translates to Bangla per sentence.
  // ---------------------------------------------------------------------------
  const usesClientLive = (direction) =>
    direction === "incoming" && state.clientSource === "live" && state.mode === "vad"

  const handleClientLiveMessage = (session, message) => {
    if (session.finished || !message || typeof message !== "object") return
    switch (message.type) {
      case "ready":
        session.ready = true
        setStatus("Client live listener on. Japanese and English will translate to Bangla.", "success")
        break
      case "status":
        if (message.state === "reconnecting") setStatus("Client listener connection dropped, reconnecting…", "warning")
        else if (message.state === "connected") setStatus("Client listener reconnected.", "success")
        break
      case "interim":
        renderInterim(message.text || "", "incoming")
        setSpeaking("incoming", Boolean(message.text))
        break
      case "segment":
        renderInterim("", "incoming")
        setSpeaking("incoming", false)
        if (message.text) {
          enqueueLiveClip(buildTextClip(message.text, "incoming", "", message.lang || ""))
        }
        break
      case "error":
        if (message.fatal) session.errorShown = true
        setStatus(`Client listener: ${message.message || "unknown error"}`, message.fatal ? "error" : "warning")
        break
      case "closed":
        finishClientLive(session)
        break
      default:
        break
    }
  }

  const startClientLive = () => {
    let port
    try {
      port = chrome.runtime.connect({ name: CLIENT_LIVE_PORT_NAME })
    } catch {
      setStatus("Extension was reloaded. Refresh this Meet tab.", "error")
      return
    }
    const session = {
      port,
      ready: false,
      streamStarted: false,
      stopping: false,
      stopSent: false,
      finished: false,
      errorShown: false,
      stopTimer: null,
      closeTimer: null,
    }
    state.clientLive = session
    port.onMessage.addListener((message) => handleClientLiveMessage(session, message))
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError
      finishClientLive(session, session.stopping ? null : "Client listener disconnected. Press start to reconnect.")
    })
    port.postMessage({ type: "start" })
    postToInject("START_STREAM", { direction: "incoming" })
    setDirectionStatus("incoming", "live")
    setStatus("Connecting live client listener (auto Japanese / English)…")
  }

  const sendClientLiveStop = (session) => {
    if (session.stopSent || session.finished) return
    session.stopSent = true
    clearTimeout(session.stopTimer)
    try {
      session.port.postMessage({ type: "stop" })
    } catch {
      finishClientLive(session)
      return
    }
    session.closeTimer = setTimeout(() => finishClientLive(session), REALTIME_CLOSE_TIMEOUT_MS)
  }

  const stopClientLive = (session, message = "Finishing client's last words…") => {
    if (session.stopping) return
    session.stopping = true
    postToInject("STOP_STREAM", { direction: "incoming" })
    session.stopTimer = setTimeout(() => sendClientLiveStop(session), REALTIME_STOP_FALLBACK_MS)
    setDirectionStatus("incoming", "processing")
    setStatus(message)
  }

  const finishClientLive = (session, errorMessage = null) => {
    if (session.finished) return
    session.finished = true
    clearTimeout(session.stopTimer)
    clearTimeout(session.closeTimer)
    renderInterim("", "incoming")
    try {
      session.port.disconnect()
    } catch {
      // Already disconnected.
    }
    if (state.clientLive !== session) return
    state.clientLive = null
    if (!session.stopping) postToInject("STOP_STREAM", { direction: "incoming" })
    setDirectionStatus("incoming", "idle")
    if (errorMessage && !session.errorShown) setStatus(errorMessage, "error")
    else if (!session.errorShown) refreshLiveStatus()
  }

  const handleClientLiveStreamStatus = (streamState) => {
    const session = state.clientLive
    if (!session) return
    if (streamState === "streaming") {
      session.streamStarted = true
      return
    }
    if (!session.stopping) stopClientLive(session, "Meeting audio stopped.")
    sendClientLiveStop(session)
  }

  // ---------------------------------------------------------------------------
  // OpenAI live interpreter (simultaneous): the mic streams to the backend and
  // the translated voice streams back into the meeting while you keep talking.
  // ---------------------------------------------------------------------------
  const usesRealtime = (direction) => direction === "outgoing" && state.engine === "realtime" && state.mode === "vad"

  const createLiveEntry = (session) => {
    const targetLabel = LANG_LABELS[session.targetLang] || session.targetLang.toUpperCase()
    const source = el("p", { className: "mai-entry-source", lang: "bn" })
    const translation = el("p", { className: "mai-entry-translation", lang: session.targetLang })
    const article = el("article", { className: "mai-entry mai-entry-outgoing", "data-live": "true" }, [
      el("p", { className: "mai-entry-meta", text: `You · Bangla → ${targetLabel} · live` }),
      source,
      translation,
    ])
    appendToLog(article)
    return { article, source, translation, sourceText: "", translationText: "", idleTimer: null }
  }

  // Closes the current card and adds it to the context and the meeting summary.
  const finalizeLiveEntry = (session) => {
    const entry = session.entry
    if (!entry) return
    session.entry = null
    clearTimeout(entry.idleTimer)
    entry.article.removeAttribute("data-live")
    const transcript = entry.sourceText.trim()
    const translated = entry.translationText.trim()
    if (!translated) entry.translation.textContent = "(no translation)"
    rememberTurn("outgoing", transcript)
    if (transcript || translated) recordHistory("outgoing", { transcript, translated_text: translated }, {})
  }

  // Deltas are append-only pieces of text (no spaces need to be added between them).
  const appendLiveDelta = (session, field, delta) => {
    if (typeof delta !== "string" || !delta) return
    if (!session.entry) session.entry = createLiveEntry(session)
    const entry = session.entry
    const pinned = isLogPinnedToBottom()
    if (field === "source") {
      entry.sourceText += delta
      entry.source.textContent = entry.sourceText
    } else {
      entry.translationText += delta
      entry.translation.textContent = entry.translationText
    }
    if (pinned) ui.log.scrollTop = ui.log.scrollHeight

    clearTimeout(entry.idleTimer)
    const sentenceEnded = field === "translation" && /[。．.!?！？]\s*$/.test(delta)
    if (sentenceEnded && entry.translationText.length >= LIVE_ENTRY_MAX_CHARS) {
      finalizeLiveEntry(session)
      return
    }
    entry.idleTimer = setTimeout(() => {
      if (session.entry === entry) finalizeLiveEntry(session)
    }, LIVE_ENTRY_IDLE_MS)
  }

  const handleRealtimeMessage = (session, message) => {
    if (session.finished || !message || typeof message !== "object") return
    switch (message.type) {
      case "ready":
        session.ready = true
        setStatus(
          `Live interpreter on. Speak Bangla; the client hears ${LANG_LABELS[session.targetLang]} while you talk.`,
          "success"
        )
        break
      case "status":
        if (message.state === "reconnecting") setStatus("Live interpreter connection dropped, reconnecting…", "warning")
        else if (message.state === "connected") setStatus("Live interpreter reconnected.", "success")
        break
      case "source_delta":
        appendLiveDelta(session, "source", message.delta)
        break
      case "translation_delta":
        appendLiveDelta(session, "translation", message.delta)
        break
      case "audio":
        if (typeof message.audio === "string" && message.audio.length > 0) {
          postToInject("PCM_PLAY", { direction: "outgoing", audioBase64: message.audio, sampleRate: message.sampleRate })
        }
        break
      case "error":
        if (message.fatal) session.errorShown = true
        setStatus(`Live interpreter: ${message.message || "unknown error"}`, message.fatal ? "error" : "warning")
        break
      case "closed":
        finishRealtime(session)
        break
      default:
        break
    }
  }

  const startRealtime = () => {
    if (!state.micReady) {
      setStatus("Turn on your Google Meet microphone first.", "error")
      return
    }
    let port
    try {
      port = chrome.runtime.connect({ name: REALTIME_PORT_NAME })
    } catch {
      setStatus("Extension was reloaded. Refresh this Meet tab.", "error")
      return
    }
    const session = {
      port,
      targetLang: state.targetLang,
      ready: false,
      streamStarted: false,
      stopping: false,
      stopSent: false,
      finished: false,
      errorShown: false,
      stopTimer: null,
      closeTimer: null,
      entry: null,
    }
    state.realtime = session
    port.onMessage.addListener((message) => handleRealtimeMessage(session, message))
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError
      finishRealtime(session, session.stopping ? null : "Live interpreter disconnected. Press start to reconnect.")
    })
    port.postMessage({ type: "start", targetLang: session.targetLang })
    // Start streaming right away; audio is queued until the interpreter is ready,
    // so the first words are not lost.
    postToInject("START_STREAM", { direction: "outgoing" })
    setDirectionStatus("outgoing", "live")
    setStatus(`Connecting the live interpreter (Bangla → ${LANG_LABELS[session.targetLang]})…`)
  }

  const sendRealtimeStop = (session) => {
    if (session.stopSent || session.finished) return
    session.stopSent = true
    clearTimeout(session.stopTimer)
    try {
      session.port.postMessage({ type: "stop" })
    } catch {
      finishRealtime(session)
      return
    }
    session.closeTimer = setTimeout(() => finishRealtime(session), REALTIME_CLOSE_TIMEOUT_MS)
  }

  // Stops the mic stream first; the interpreter is told to stop only after the
  // last audio frame has been sent, so the final words are still translated.
  const stopRealtime = (session, message = "Finishing your last words…") => {
    if (session.stopping) return
    session.stopping = true
    postToInject("STOP_STREAM", { direction: "outgoing" })
    session.stopTimer = setTimeout(() => sendRealtimeStop(session), REALTIME_STOP_FALLBACK_MS)
    setDirectionStatus("outgoing", "processing")
    setStatus(message)
  }

  const finishRealtime = (session, errorMessage = null) => {
    if (session.finished) return
    session.finished = true
    clearTimeout(session.stopTimer)
    clearTimeout(session.closeTimer)
    finalizeLiveEntry(session)
    try {
      session.port.disconnect()
    } catch {
      // Already disconnected.
    }
    if (state.realtime !== session) return
    state.realtime = null
    if (!session.stopping) postToInject("STOP_STREAM", { direction: "outgoing" })
    setDirectionStatus("outgoing", "idle")
    if (errorMessage && !session.errorShown) setStatus(errorMessage, "error")
    else if (!session.errorShown) refreshLiveStatus()
  }

  const handleRealtimeStreamStatus = (streamState) => {
    const session = state.realtime
    if (streamState === "streaming") {
      session.streamStarted = true
      return
    }
    // stream_stopped: either we asked for it, or Meet released the microphone.
    if (!session.stopping) stopRealtime(session, "Microphone stopped. Finishing your last words…")
    sendRealtimeStop(session)
  }

  // ---------------------------------------------------------------------------
  // Meeting summary
  // ---------------------------------------------------------------------------
  const renderSummaryButton = () => {
    const { status } = state.summary
    const count = state.history.length
    ui.summaryBtn.disabled = count === 0 || status === "loading"
    ui.summaryBtn.textContent = status === "loading" ? "Summarizing…" : "Summarize meeting"
    if (status === "loading") ui.summaryBtn.setAttribute("aria-busy", "true")
    else ui.summaryBtn.removeAttribute("aria-busy")
    ui.summaryHint.textContent =
      count === 0
        ? "Available after the first translation."
        : `Decisions, action items and open questions from ${count} ${count === 1 ? "turn" : "turns"}, in Bangla and English.`
  }

  const handleSummarize = async () => {
    if (state.history.length === 0 || state.summary.status === "loading") return
    state.summary = { status: "loading", text: state.summary.text }
    renderSummaryButton()
    setStatus("Summarizing the meeting…")

    const response = await sendToBackground("SUMMARIZE", { turns: state.history.slice() })
    if (!response.ok || !response.data?.summary) {
      state.summary = { status: "error", text: state.summary.text }
      renderSummaryButton()
      setStatus(`Couldn't summarize: ${response.error || "empty summary"}. Press Summarize to try again.`, "error")
      return
    }
    state.summary = { status: "done", text: response.data.summary }
    renderSummaryButton()
    ui.summaryText.textContent = state.summary.text
    ui.summaryFeedback.textContent = ""
    ui.summaryResult.hidden = false
    ui.summaryText.focus()
    setStatus("Summary ready.", "success")
  }

  const handleSummaryCopy = async () => {
    try {
      await navigator.clipboard.writeText(state.summary.text)
      ui.summaryFeedback.textContent = "Copied."
      ui.summaryFeedback.dataset.tone = "success"
    } catch {
      ui.summaryFeedback.textContent = "Couldn't copy. Select the text and press Cmd+C."
      ui.summaryFeedback.dataset.tone = "error"
    }
  }

  const handleSummaryDownload = () => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")
    const blob = new Blob([state.summary.text], { type: "text/plain;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const link = el("a", { href: url, download: `meeting-summary-${stamp}.txt` })
    document.body.append(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    ui.summaryFeedback.textContent = "Downloaded."
    ui.summaryFeedback.dataset.tone = "success"
  }

  const handleSummaryClose = () => {
    ui.summaryResult.hidden = true
    ui.summaryBtn.focus()
  }

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------
  const handleToggle = (direction) => {
    const { status } = state.directions[direction]
    if (status === "processing") return
    const isOn = status === "recording" || status === "live"

    if (direction === "outgoing" && state.realtime) {
      stopRealtime(state.realtime)
      return
    }
    if (direction === "outgoing" && state.speech) {
      stopBrowserStt()
      return
    }
    if (direction === "incoming" && state.clientLive) {
      stopClientLive(state.clientLive)
      return
    }
    if (direction === "incoming" && state.captions) {
      stopCaptions()
      return
    }
    if (isOn) {
      postToInject("STOP_REC", { direction })
      return
    }
    if (usesRealtime(direction)) {
      startRealtime()
      return
    }
    if (usesBrowserStt(direction)) {
      startBrowserStt()
      return
    }
    if (usesClientLive(direction)) {
      startClientLive()
      return
    }
    if (usesCaptions(direction)) {
      startCaptions()
      return
    }
    postToInject("START_REC", { direction, mode: state.mode, silenceMs: state.silenceMs })
  }

  // Both on: stop both. Otherwise start whichever direction isn't running yet.
  const handleConversationToggle = () => {
    if (state.mode !== "vad") return
    if (DIRECTIONS.some((direction) => state.directions[direction].status === "processing")) return
    const live = DIRECTIONS.filter((direction) => state.directions[direction].status === "live")
    if (live.length === DIRECTIONS.length) {
      live.forEach(handleToggle)
      return
    }
    DIRECTIONS.filter((direction) => !isActive(direction)).forEach(handleToggle)
  }

  const handleRetry = () => {
    const direction = state.retryDirection
    const clip = direction && state.directions[direction].failedClip
    if (!clip) return
    state.directions[direction].failedClip = null
    if (state.directions[direction].status === "live") enqueueLiveClip(clip)
    else processClip(clip)
  }

  const handleModeChange = (event) => {
    if (anyActive() || !MODES.includes(event.target.value)) {
      renderModeSwitch()
      return
    }
    state.mode = event.target.value
    storageSet({ mode: state.mode })
    renderAll()
  }

  const handlePauseChange = (event) => {
    const value = Number(event.target.value)
    state.silenceMs = PAUSE_OPTIONS.some((option) => option.value === value) ? value : DEFAULT_SILENCE_MS
    storageSet({ silenceMs: state.silenceMs })
  }

  const handleVoiceRateChange = (event) => {
    const value = Number(event.target.value)
    state.voiceRate = VOICE_RATES.some((option) => option.value === value) ? value : DEFAULT_VOICE_RATE
    storageSet({ voiceRate: state.voiceRate })
  }

  const handleClientSourceChange = (event) => {
    const source = event.target.value
    state.clientSource = CLIENT_SOURCES.includes(source) && (source !== "captions" || Captions) ? source : DEFAULT_CLIENT_SOURCE
    event.target.value = state.clientSource
    storageSet({ [CLIENT_SOURCE_STORAGE_KEY]: state.clientSource })
  }

  const handleEngineChange = (event) => {
    const engine = event.target.value
    state.engine = ENGINES.includes(engine) && (engine !== "google" || SpeechRecognitionApi) ? engine : DEFAULT_ENGINE
    event.target.value = state.engine
    storageSet({ [ENGINE_STORAGE_KEY]: state.engine })
    renderModeSwitch()
    if (isActive("outgoing")) setStatus("Engine change applies after you stop and start again.", "warning")
  }

  const handleHeadphonesChange = (event) => {
    state.headphones = event.target.checked
    storageSet({ headphones: state.headphones })
    postToInject("SETTINGS", { gateOnPlayback: !state.headphones })
  }

  const handleSpeakBanglaChange = (event) => {
    state.speakBangla = event.target.checked
    storageSet({ speakBangla: state.speakBangla })
  }

  const handleLangChange = (event) => {
    state.targetLang = event.target.value === "en" ? "en" : "ja"
    storageSet({ targetLang: state.targetLang })
    if (state.realtime && state.realtime.targetLang !== state.targetLang) {
      setStatus("The live interpreter switches language after you stop and start again.", "warning")
    }
  }

  const handleCollapseToggle = () => {
    state.collapsed = !state.collapsed
    applyCollapsed()
    storageSet({ collapsed: state.collapsed })
  }

  const applyCollapsed = () => {
    ui.panel.dataset.collapsed = String(state.collapsed)
    ui.body.hidden = state.collapsed
    ui.collapseBtn.setAttribute("aria-expanded", String(!state.collapsed))
    ui.collapseBtn.setAttribute("aria-label", state.collapsed ? "Expand interpreter panel" : "Collapse interpreter panel")
    ui.collapseBtn.title = state.collapsed ? "Expand" : "Collapse"
    ui.collapseBtn.textContent = state.collapsed ? "+" : "–"
  }

  const handleShortcut = (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.repeat) return
    if (event.code === "KeyC") {
      if (state.mode !== "vad") return
      event.preventDefault()
      event.stopPropagation()
      handleConversationToggle()
      return
    }
    const direction = event.code === "KeyB" ? "outgoing" : event.code === "KeyL" ? "incoming" : null
    if (!direction) return
    event.preventDefault()
    event.stopPropagation()
    handleToggle(direction)
  }

  const handleStatusMessage = (direction, msg) => {
    const directionState = state.directions[direction]
    if (direction === "outgoing" && state.realtime && (msg.state === "streaming" || msg.state === "stream_stopped")) {
      handleRealtimeStreamStatus(msg.state)
      return
    }
    if (direction === "incoming" && state.clientLive && (msg.state === "streaming" || msg.state === "stream_stopped")) {
      handleClientLiveStreamStatus(msg.state)
      return
    }
    // Live interpreter playback/stream events that need no UI change.
    if (["streaming", "stream_stopped", "voice_on", "voice_off"].includes(msg.state)) return
    if (direction === "incoming" && (msg.state === "playing" || msg.state === "played")) {
      state.incomingPlaying = msg.state === "playing"
    }

    if (msg.state === "recording") {
      setDirectionStatus(direction, "recording")
      setStatus(
        direction === "outgoing"
          ? "Recording your Bangla. Meet hears nothing until you stop."
          : "Recording the client. Press again when they finish."
      )
      return
    }
    if (msg.state === "live") {
      setDirectionStatus(direction, "live")
      refreshLiveStatus()
      return
    }
    if (msg.state === "speech" || msg.state === "silence") {
      if (directionState.status !== "live") return
      directionState.speaking = msg.state === "speech"
      renderButton(direction)
      renderConversationButton()
      return
    }
    if (msg.state === "stopped") {
      setDirectionStatus(direction, "idle")
      refreshLiveStatus()
      return
    }
    if (msg.state === "discarded") {
      setDirectionStatus(direction, "idle")
      setStatus(msg.message || "Clip discarded.", "warning")
      return
    }
    if (msg.state === "played") {
      const busy = DIRECTIONS.some((d) => state.directions[d].status === "processing")
      if (!busy && ui.status.dataset.tone !== "error") refreshLiveStatus()
    }
  }

  const handleInjectMessage = (event) => {
    if (event.source !== window) return
    const msg = event.data
    if (!msg || msg.source !== SOURCE || msg.target !== "bridge") return

    if (msg.type === "MIC") {
      state.micReady = Boolean(msg.ready)
      state.micMuted = Boolean(msg.muted)
      renderMic()
      return
    }

    const { direction } = msg
    if (!DIRECTIONS.includes(direction)) return

    if (msg.type === "STATUS") {
      handleStatusMessage(direction, msg)
      return
    }

    if (msg.type === "PCM") {
      if (!(msg.buffer instanceof ArrayBuffer) || msg.buffer.byteLength === 0) return
      if (direction === "outgoing") {
        const session = state.realtime
        if (!session || session.finished || session.stopSent) return
        try {
          session.port.postMessage({ type: "audio", audio: arrayBufferToBase64(msg.buffer) })
        } catch {
          finishRealtime(session, "Live interpreter disconnected. Press start to reconnect.")
        }
        return
      }
      if (direction === "incoming") {
        const session = state.clientLive
        if (!session || session.finished || session.stopSent) return
        try {
          session.port.postMessage({ type: "audio", audio: arrayBufferToBase64(msg.buffer) })
        } catch {
          finishClientLive(session, "Client listener disconnected. Press start to reconnect.")
        }
        return
      }
      return
    }

    if (msg.type === "ERROR") {
      // The mic stream couldn't start, so the live interpreter has nothing to translate.
      if (direction === "outgoing" && state.realtime && !state.realtime.streamStarted) {
        state.realtime.errorShown = true
        setStatus(msg.message || "Couldn't start the microphone stream.", "error")
        finishRealtime(state.realtime)
        return
      }
      if (direction === "incoming" && state.clientLive && !state.clientLive.streamStarted) {
        state.clientLive.errorShown = true
        setStatus(msg.message || "Couldn't capture meeting audio.", "error")
        finishClientLive(state.clientLive)
        return
      }
      if (direction === "incoming") state.incomingPlaying = false
      const { status } = state.directions[direction]
      if (status !== "processing" && status !== "live") setDirectionStatus(direction, "idle")
      setStatus(msg.message || "Something went wrong.", "error")
      return
    }

    if (msg.type === "CLIP") {
      if (!(msg.buffer instanceof ArrayBuffer) || msg.buffer.byteLength === 0) return
      const clip = {
        direction,
        audioBase64: arrayBufferToBase64(msg.buffer),
        mime: typeof msg.mime === "string" ? msg.mime : "audio/webm",
        targetLang: state.targetLang,
        context: state.recentTurns.slice(),
        speak: direction === "outgoing" || state.speakBangla,
        voiceRate: state.voiceRate,
      }
      if (msg.mode === "vad") {
        enqueueLiveClip(clip)
        return
      }
      processClip(clip)
      if (msg.autoStopped) setStatus("Reached the 60 second limit, translating what was recorded…")
    }
  }

  // ---------------------------------------------------------------------------
  // Dragging
  // ---------------------------------------------------------------------------
  const clampPosition = (panel, left, top) => {
    const maxLeft = window.innerWidth - panel.offsetWidth - 8
    const maxTop = window.innerHeight - panel.offsetHeight - 8
    return { left: Math.max(8, Math.min(left, maxLeft)), top: Math.max(8, Math.min(top, maxTop)) }
  }

  const applyPosition = (panel, position) => {
    if (!position) return
    const { left, top } = clampPosition(panel, position.left, position.top)
    panel.style.left = `${left}px`
    panel.style.top = `${top}px`
    panel.style.right = "auto"
    panel.style.bottom = "auto"
  }

  const enableDragging = (panel, handle) => {
    let drag = null

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("button, select, input")) return
      const rect = panel.getBoundingClientRect()
      drag = { offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top }
      handle.setPointerCapture(event.pointerId)
      panel.dataset.dragging = "true"
    })

    handle.addEventListener("pointermove", (event) => {
      if (!drag) return
      applyPosition(panel, { left: event.clientX - drag.offsetX, top: event.clientY - drag.offsetY })
    })

    const endDrag = (event) => {
      if (!drag) return
      drag = null
      handle.releasePointerCapture(event.pointerId)
      panel.dataset.dragging = "false"
      const rect = panel.getBoundingClientRect()
      storageSet({ position: { left: rect.left, top: rect.top } })
    }
    handle.addEventListener("pointerup", endDrag)
    handle.addEventListener("pointercancel", endDrag)
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  const init = async () => {
    buildHud()

    const saved = await storageGet([
      "targetLang", "collapsed", "position", "mode", "silenceMs", "speakBangla", ENGINE_STORAGE_KEY, "voiceRate", CLIENT_SOURCE_STORAGE_KEY, "clientSource",
      "headphones",
    ])
    state.targetLang = saved.targetLang === "en" ? "en" : "ja"
    state.mode = MODES.includes(saved.mode) ? saved.mode : "vad"
    state.silenceMs = PAUSE_OPTIONS.some((option) => option.value === saved.silenceMs) ? saved.silenceMs : DEFAULT_SILENCE_MS
    state.collapsed = Boolean(saved.collapsed)
    state.speakBangla = saved.speakBangla !== false
    const savedEngine = saved[ENGINE_STORAGE_KEY]
    state.engine = ENGINES.includes(savedEngine) && (savedEngine !== "google" || SpeechRecognitionApi) ? savedEngine : DEFAULT_ENGINE
    state.headphones = saved.headphones !== false
    state.voiceRate = VOICE_RATES.some((option) => option.value === saved.voiceRate) ? saved.voiceRate : DEFAULT_VOICE_RATE
    const savedClientSource = saved[CLIENT_SOURCE_STORAGE_KEY] || saved.clientSource
    state.clientSource = CLIENT_SOURCES.includes(savedClientSource) && (savedClientSource !== "captions" || Captions)
      ? savedClientSource
      : DEFAULT_CLIENT_SOURCE

    ui.langSelect.value = state.targetLang
    ui.pauseSelect.value = String(state.silenceMs)
    ui.speakBanglaInput.checked = state.speakBangla
    ui.engineSelect.value = state.engine
    ui.headphonesInput.checked = state.headphones
    ui.voiceRateSelect.value = String(state.voiceRate)
    ui.clientSourceSelect.value = state.clientSource
    renderSummaryButton()
    renderAll()
    renderMic()
    applyCollapsed()
    applyPosition(ui.panel, saved.position)

    window.addEventListener("message", handleInjectMessage)
    window.addEventListener("keydown", handleShortcut, { capture: true })
    window.addEventListener("resize", () => {
      if (ui.panel.style.left) applyPosition(ui.panel, { left: ui.panel.offsetLeft, top: ui.panel.offsetTop })
    })
    postToInject("HELLO")
    postToInject("SETTINGS", { gateOnPlayback: !state.headphones })
  }

  init()
})()
