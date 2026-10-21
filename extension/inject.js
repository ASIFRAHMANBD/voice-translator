// Runs in the page's MAIN world at document_start so it can wrap getUserMedia
// before Google Meet captures a reference to it. No chrome.* APIs exist here;
// everything that needs the extension goes through bridge.js via postMessage.
;(() => {
  if (window.__meetAiInterpreterInstalled) return
  window.__meetAiInterpreterInstalled = true

  const SOURCE = "meet-ai"
  const MIN_CLIP_MS = 300
  const MAX_CLIP_MS = 60_000
  const DUCK_VOLUME = 0.2
  const RECORDER_MIME = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find(
    (type) => window.MediaRecorder && MediaRecorder.isTypeSupported(type)
  ) || ""
  const RECORDER_OPTIONS = RECORDER_MIME ? { mimeType: RECORDER_MIME, audioBitsPerSecond: 128_000 } : undefined

  // Hands-free voice activity detection (energy based), used by the Whisper fallback.
  // Cuts happen only at real pauses: a forced cut mid-word garbles both halves.
  const VAD = {
    frameMs: 30,
    minRms: 0.010,
    maxNoiseFloor: 0.008,
    noiseFactor: 2.0,
    maxThreshold: 0.022,
    holdFactor: 0.6,
    onsetMs: 90,
    minSpeechMs: 300,
    defaultSilenceMs: 600,
    softMaxMs: 9_000,
    softPauseMs: 250,
    hardMaxMs: 15_000,
    idleResetMs: 8_000,
  }

  // Live interpreter (OpenAI realtime translation): raw mic audio in, translated audio out.
  const STREAM = {
    rate: 24_000,
    // The translation engine works in 200 ms frames.
    frameSamples: 4_800,
    processorSize: 4_096,
    speechRms: 0.012,
    speechHangoverMs: 500,
    playbackLeadS: 0.08,
    // Translated audio arrives as a continuous stream including silence; skip the
    // silence when we fall behind so delay never builds up.
    maxSilentBacklogS: 0.3,
    silentPeak: 0.01,
    // Client audio: sensitive threshold to reflect speech in UI without dropping frames.
    incomingSpeechRms: 0.001,
    incomingHangoverMs: 1_000,
  }

  const state = {
    audioCtx: null,
    virtualMicDest: null,
    realMicStream: null,
    liveVirtualTracks: new Set(),
    meetMuted: false,
    recorders: { outgoing: null, incoming: null },
    live: { outgoing: null, incoming: null },
    streams: { outgoing: null, incoming: null },
    pcmPlayers: { outgoing: null, incoming: null },
    // Without headphones the client's Bangla voice leaks into the mic; then mute
    // outgoing capture while it plays. With headphones, keep listening.
    gateOnPlayback: false,
    incoming: { bus: null, dest: null, sources: new Map(), observer: null, rescanTimer: null, users: 0 },
    playQueues: { outgoing: Promise.resolve(), incoming: Promise.resolve() },
    duckCount: 0,
    duckedVolumes: new Map(),
  }

  const post = (type, payload = {}, transfer = []) => {
    window.postMessage({ source: SOURCE, target: "bridge", type, ...payload }, window.location.origin, transfer)
  }

  const log = (...args) => console.info("[AI Interpreter]", ...args)

  // ---------------------------------------------------------------------------
  // Audio graph
  // ---------------------------------------------------------------------------
  const ensureAudioGraph = () => {
    if (state.audioCtx) return state.audioCtx
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext
    state.audioCtx = new AudioContextCtor()
    state.virtualMicDest = state.audioCtx.createMediaStreamDestination()
    return state.audioCtx
  }

  const resumeAudio = async () => {
    const ctx = ensureAudioGraph()
    if (ctx.state === "suspended") await ctx.resume()
  }

  // Chrome starts AudioContexts suspended until a user gesture.
  window.addEventListener("pointerdown", () => { resumeAudio().catch(() => {}) }, { capture: true })
  window.addEventListener("keydown", () => { resumeAudio().catch(() => {}) }, { capture: true })

  // ---------------------------------------------------------------------------
  // getUserMedia override: Meet receives the virtual mic, we keep the real one
  // ---------------------------------------------------------------------------
  const mediaDevices = navigator.mediaDevices
  if (!mediaDevices || !mediaDevices.getUserMedia) {
    log("navigator.mediaDevices.getUserMedia unavailable; interpreter disabled")
    return
  }
  const originalGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices)

  const postMicState = () => {
    post("MIC", { ready: Boolean(state.realMicStream), muted: state.meetMuted })
  }

  const stopRealMic = () => {
    if (!state.realMicStream) return
    if (state.live.outgoing) stopLive("outgoing", false)
    if (state.streams.outgoing) stopStream("outgoing")
    state.realMicStream.getTracks().forEach((track) => track.stop())
    state.realMicStream = null
    postMicState()
  }

  const replaceRealMic = (audioTracks) => {
    const previous = state.realMicStream
    state.realMicStream = new MediaStream(audioTracks)
    if (previous) previous.getTracks().forEach((track) => track.stop())
    postMicState()

    const session = state.live.outgoing
    if (session) {
      stopLive("outgoing", true)
      startLive("outgoing", session.silenceMs)
    }
    // Meet switched microphones: keep the live interpreter on the new one.
    if (state.streams.outgoing) {
      stopStream("outgoing", false)
      startStream("outgoing").catch(reportError("outgoing"))
    }
  }

  const isOutgoingCaptureActive = () =>
    state.recorders.outgoing?.state === "recording" || Boolean(state.live.outgoing) || Boolean(state.streams.outgoing)

  const createVirtualTrack = () => {
    ensureAudioGraph()
    const track = state.virtualMicDest.stream.getAudioTracks()[0].clone()
    const originalStop = track.stop.bind(track)
    state.liveVirtualTracks.add(track)
    track.stop = () => {
      originalStop()
      state.liveVirtualTracks.delete(track)
      if (state.liveVirtualTracks.size === 0 && !isOutgoingCaptureActive()) stopRealMic()
    }
    return track
  }

  // Meet mutes by disabling the track it was given. When every virtual track is
  // disabled the meeting can't hear the translation, so hands-free pauses too.
  const checkMeetMuted = () => {
    const tracks = Array.from(state.liveVirtualTracks).filter((track) => track.readyState === "live")
    const muted = tracks.length > 0 && tracks.every((track) => !track.enabled)
    if (muted === state.meetMuted) return
    state.meetMuted = muted
    postMicState()
  }
  window.setInterval(checkMeetMuted, 500)

  mediaDevices.getUserMedia = async (constraints) => {
    if (!constraints || !constraints.audio) return originalGetUserMedia(constraints)

    log("Meet requested microphone; attaching virtual mic")
    const realStream = await originalGetUserMedia(constraints)
    const realAudioTracks = realStream.getAudioTracks()
    if (realAudioTracks.length === 0) return realStream

    replaceRealMic(realAudioTracks)
    return new MediaStream([...realStream.getVideoTracks(), createVirtualTrack()])
  }

  // ---------------------------------------------------------------------------
  // Incoming mix: every remote <audio> or <video> stream into one bus
  // ---------------------------------------------------------------------------
  const knownRemoteStreams = new Set()

  try {
    const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "srcObject")
    if (desc && desc.set) {
      const origSet = desc.set
      desc.set = function (stream) {
        origSet.call(this, stream)
        if (stream instanceof MediaStream) {
          knownRemoteStreams.add(stream)
          if (state.incoming.bus) connectIncomingSources()
        }
      }
      Object.defineProperty(HTMLMediaElement.prototype, "srcObject", desc)
    }
  } catch {
    // Non-fatal if property descriptor cannot be rewritten
  }

  const getMeetMediaElements = () =>
    Array.from(document.querySelectorAll("audio, video")).filter(
      (el) => el.srcObject instanceof MediaStream
    )

  const connectIncomingSources = () => {
    const { incoming, audioCtx } = state
    if (!incoming.bus) return

    const streams = new Set()
    getMeetMediaElements().forEach((el) => {
      if (el.srcObject instanceof MediaStream) streams.add(el.srcObject)
    })
    knownRemoteStreams.forEach((stream) => streams.add(stream))

    streams.forEach((stream) => {
      if (incoming.sources.has(stream)) return
      if (stream.getAudioTracks().length === 0) {
        stream.addEventListener("addtrack", () => connectIncomingSources(), { once: true })
        return
      }
      try {
        const node = audioCtx.createMediaStreamSource(stream)
        node.connect(incoming.bus)
        incoming.sources.set(stream, node)
        log(`connected incoming audio track: ${stream.id} (${stream.getAudioTracks().length} tracks)`)
      } catch (err) {
        log(`could not connect media stream source: ${err.message}`)
      }
    })
  }

  const acquireIncomingMix = () => {
    const { incoming } = state
    incoming.users += 1
    if (incoming.bus) return incoming
    const ctx = ensureAudioGraph()
    incoming.bus = ctx.createGain()
    // Boost remote audio gain slightly (1.5x) so OpenAI Whisper receives clear, healthy amplitude
    incoming.bus.gain.value = 1.5
    incoming.dest = ctx.createMediaStreamDestination()
    incoming.bus.connect(incoming.dest)
    connectIncomingSources()
    incoming.observer = new MutationObserver(connectIncomingSources)
    incoming.observer.observe(document.body, { childList: true, subtree: true })
    // Rescan every 500 ms in case Google Meet dynamically mounts elements or reassigns streams
    incoming.rescanTimer = window.setInterval(connectIncomingSources, 500)
    return incoming
  }

  const releaseIncomingMix = () => {
    const { incoming } = state
    incoming.users = Math.max(0, incoming.users - 1)
    if (incoming.users > 0 || !incoming.bus) return
    incoming.observer?.disconnect()
    window.clearInterval(incoming.rescanTimer)
    incoming.sources.forEach((node) => node.disconnect())
    incoming.sources.clear()
    incoming.bus.disconnect()
    incoming.bus = null
    incoming.dest = null
    incoming.observer = null
    incoming.rescanTimer = null
  }

  // ---------------------------------------------------------------------------
  // Shared clip emitter
  // ---------------------------------------------------------------------------
  const emitClip = async (direction, chunks, mime, durationMs, extra = {}) => {
    const blob = new Blob(chunks, { type: mime })
    log(`${direction} clip: ${durationMs} ms, ${blob.size} bytes, ${mime}`)
    if (blob.size === 0) return
    const buffer = await blob.arrayBuffer()
    post("CLIP", { direction, buffer, mime, durationMs, ...extra })
  }

  // ---------------------------------------------------------------------------
  // Push-to-talk recording
  // ---------------------------------------------------------------------------
  const startRecording = async (direction) => {
    if (state.recorders[direction]?.state === "recording" || state.live[direction]) return
    await resumeAudio()

    let stream = null
    if (direction === "outgoing") {
      if (!state.realMicStream) {
        post("ERROR", { direction, message: "Turn on your Google Meet microphone first." })
        return
      }
      stream = state.realMicStream
    } else {
      const incoming = acquireIncomingMix()
      if (incoming.sources.size === 0) {
        releaseIncomingMix()
        post("ERROR", { direction, message: "No client audio found yet. Wait until someone joins and speaks." })
        return
      }
      stream = incoming.dest.stream
    }

    const chunks = []
    const recorder = new MediaRecorder(stream, RECORDER_OPTIONS)
    const startedAt = performance.now()
    const autoStopTimer = window.setTimeout(() => {
      if (recorder.state === "recording") recorder.stop()
    }, MAX_CLIP_MS)

    const cleanup = () => {
      window.clearTimeout(autoStopTimer)
      state.recorders[direction] = null
      if (direction === "incoming") releaseIncomingMix()
      if (direction === "outgoing" && state.liveVirtualTracks.size === 0 && !state.live.outgoing) stopRealMic()
    }

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data)
    }

    recorder.onstop = () => {
      cleanup()
      const durationMs = Math.round(performance.now() - startedAt)
      if (durationMs < MIN_CLIP_MS) {
        post("STATUS", { direction, state: "discarded", message: "Clip too short. Hold a little longer." })
        return
      }
      const mime = recorder.mimeType || RECORDER_MIME || "audio/webm"
      emitClip(direction, chunks, mime, durationMs, { mode: "ptt", autoStopped: durationMs >= MAX_CLIP_MS })
    }

    recorder.onerror = (event) => {
      cleanup()
      post("ERROR", { direction, message: `Recorder error: ${event.error?.message || "unknown"}` })
    }

    state.recorders[direction] = recorder
    recorder.start(250)
    post("STATUS", { direction, state: "recording" })
  }

  const stopRecording = (direction) => {
    const recorder = state.recorders[direction]
    if (!recorder || recorder.state !== "recording") return
    recorder.stop()
  }

  // ---------------------------------------------------------------------------
  // Hands-free: one MediaRecorder per utterance, cut at each pause
  // ---------------------------------------------------------------------------
  const startSegment = (session) => {
    const chunks = []
    const recorder = new MediaRecorder(session.stream, RECORDER_OPTIONS)
    const segment = {
      recorder,
      chunks,
      startedAt: performance.now(),
      speaking: false,
      voicedRunMs: 0,
      voicedTotalMs: 0,
      silentRunMs: 0,
      keep: false,
    }
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data)
    }
    recorder.onstop = () => {
      if (!segment.keep) return
      const durationMs = Math.round(performance.now() - segment.startedAt)
      const mime = recorder.mimeType || RECORDER_MIME || "audio/webm"
      session.seq += 1
      emitClip(session.direction, chunks, mime, durationMs, { mode: "vad", seq: session.seq })
    }
    recorder.start()
    session.segment = segment
  }

  const endSegment = (session, keep) => {
    const segment = session.segment
    if (!segment) return
    session.segment = null
    segment.keep = keep && segment.voicedTotalMs >= VAD.minSpeechMs
    if (segment.recorder.state === "recording") segment.recorder.stop()
  }

  const cutSegment = (session) => {
    post("STATUS", { direction: session.direction, state: "silence" })
    endSegment(session, true)
    session.noiseFloor = 0.004
    startSegment(session)
  }

  const readRms = (session) => {
    session.analyser.getFloatTimeDomainData(session.samples)
    let sum = 0
    for (let i = 0; i < session.samples.length; i++) sum += session.samples[i] * session.samples[i]
    return Math.sqrt(sum / session.samples.length)
  }

  const isOutgoingGated = () => state.meetMuted || (state.gateOnPlayback && state.duckCount > 0)

  const tickLive = (session) => {
    const segment = session.segment
    if (!segment) return

    const now = performance.now()
    const frameMs = Math.min(now - session.lastTickAt, 250)
    session.lastTickAt = now

    const rms = readRms(session)
    const gated = session.direction === "outgoing" && isOutgoingGated()
    const baseThreshold = Math.min(
      VAD.maxThreshold,
      Math.max(VAD.minRms, session.noiseFloor * VAD.noiseFactor)
    )
    const threshold = segment.speaking ? baseThreshold * VAD.holdFactor : baseThreshold
    const voiced = !gated && rms > threshold

    if (!voiced && !segment.speaking && rms < VAD.minRms * 1.2) {
      session.noiseFloor = Math.min(VAD.maxNoiseFloor, session.noiseFloor * 0.95 + rms * 0.05)
    }

    const ageMs = now - segment.startedAt

    if (voiced) {
      segment.voicedRunMs += frameMs
      segment.voicedTotalMs += frameMs
      segment.silentRunMs = 0
      if (!segment.speaking && segment.voicedRunMs >= VAD.onsetMs) {
        segment.speaking = true
        post("STATUS", { direction: session.direction, state: "speech" })
      }
    } else {
      segment.voicedRunMs = 0
      segment.silentRunMs += frameMs
    }

    if (segment.speaking) {
      const pausedLongEnough = segment.silentRunMs >= session.silenceMs
      const longAndBriefPause = ageMs >= VAD.softMaxMs && segment.silentRunMs >= VAD.softPauseMs
      if (pausedLongEnough || longAndBriefPause || ageMs >= VAD.hardMaxMs) cutSegment(session)
      return
    }

    // No speech yet: keep the pending recording short so clips don't carry long silence.
    if (!segment.speaking && segment.voicedRunMs === 0 && ageMs >= VAD.idleResetMs && segment.silentRunMs >= 500) {
      endSegment(session, false)
      startSegment(session)
    }
  }

  const startLive = async (direction, silenceMs) => {
    if (state.live[direction] || state.recorders[direction]?.state === "recording") return
    await resumeAudio()
    const ctx = state.audioCtx

    let stream = null
    let sourceNode = null
    if (direction === "outgoing") {
      if (!state.realMicStream) {
        post("ERROR", { direction, message: "Turn on your Google Meet microphone first." })
        return
      }
      stream = state.realMicStream
      sourceNode = ctx.createMediaStreamSource(stream)
    } else {
      const incoming = acquireIncomingMix()
      stream = incoming.dest.stream
      sourceNode = incoming.bus
    }

    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    const sink = ctx.createGain()
    sink.gain.value = 0
    sourceNode.connect(analyser)
    analyser.connect(sink)
    sink.connect(ctx.destination)

    const session = {
      direction,
      stream,
      sourceNode,
      ownsSource: direction === "outgoing",
      analyser,
      sink,
      samples: new Float32Array(analyser.fftSize),
      silenceMs: Number(silenceMs) > 0 ? Number(silenceMs) : VAD.defaultSilenceMs,
      noiseFloor: 0.004,
      lastTickAt: performance.now(),
      segment: null,
      seq: 0,
      timer: null,
    }
    state.live[direction] = session
    startSegment(session)
    session.timer = window.setInterval(() => tickLive(session), VAD.frameMs)
    post("STATUS", { direction, state: "live" })
  }

  const stopLive = (direction, flush) => {
    const session = state.live[direction]
    if (!session) return
    state.live[direction] = null
    window.clearInterval(session.timer)
    endSegment(session, flush)
    session.analyser.disconnect()
    session.sink.disconnect()
    if (session.ownsSource) session.sourceNode.disconnect()
    else session.sourceNode.disconnect(session.analyser)
    if (direction === "incoming") releaseIncomingMix()
    post("STATUS", { direction, state: "stopped" })
  }

  // ---------------------------------------------------------------------------
  // Live interpreter: continuous 24 kHz PCM16 mic stream in 200 ms frames
  // ---------------------------------------------------------------------------
  // Box-filter resampler (enough anti-aliasing for speech), stateful across buffers.
  const createResampler = (inRate, outRate) => {
    const ratio = inRate / outRate
    const half = ratio / 2
    let carry = new Float32Array(0)
    let pos = half
    return (input) => {
      const merged = new Float32Array(carry.length + input.length)
      merged.set(carry)
      merged.set(input, carry.length)
      const out = new Float32Array(Math.ceil(merged.length / ratio) + 1)
      let count = 0
      while (pos + half <= merged.length) {
        const start = Math.max(0, Math.floor(pos - half))
        const end = Math.min(merged.length, Math.max(start + 1, Math.ceil(pos + half)))
        let sum = 0
        for (let i = start; i < end; i++) sum += merged[i]
        out[count++] = sum / (end - start)
        pos += ratio
      }
      const keepFrom = Math.max(0, Math.floor(pos - half))
      carry = merged.slice(keepFrom)
      pos -= keepFrom
      return out.subarray(0, count)
    }
  }

  const emitStreamFrame = (stream, samples) => {
    post("PCM", { direction: stream.direction, buffer: samples.buffer }, [samples.buffer])
  }

  const handleStreamAudio = (stream, input) => {
    // Muted in Meet (or the client's Bangla is playing without headphones): send
    // silence rather than nothing, so the interpreter's timing stays continuous.
    const isOutgoing = stream.direction === "outgoing"
    const gated = isOutgoing && isOutgoingGated()

    let sum = 0
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i]
    const now = performance.now()
    const threshold = isOutgoing ? STREAM.speechRms : STREAM.incomingSpeechRms
    if (!gated && Math.sqrt(sum / input.length) > threshold) stream.lastVoiceAt = now
    const speaking = now - stream.lastVoiceAt < STREAM.speechHangoverMs
    if (speaking !== stream.speaking) {
      stream.speaking = speaking
      post("STATUS", { direction: stream.direction, state: speaking ? "speech" : "silence" })
    }
    const samples = stream.resample(input)
    for (let i = 0; i < samples.length; i++) {
      const value = gated ? 0 : Math.max(-1, Math.min(1, samples[i]))
      stream.pending[stream.filled++] = value < 0 ? value * 0x8000 : value * 0x7fff
      if (stream.filled === STREAM.frameSamples) {
        emitStreamFrame(stream, stream.pending)
        stream.pending = new Int16Array(STREAM.frameSamples)
        stream.filled = 0
      }
    }
  }

  const startStream = async (direction) => {
    if (state.streams[direction]) return
    await resumeAudio()
    const ctx = state.audioCtx
    let source = null
    if (direction === "outgoing") {
      if (!state.realMicStream) {
        post("ERROR", { direction, message: "Turn on your Google Meet microphone first." })
        return
      }
      source = ctx.createMediaStreamSource(state.realMicStream)
    } else {
      // Every remote participant mixed together; new ones are added as they join.
      source = acquireIncomingMix().bus
    }
    // ScriptProcessor needs no module URL, so Meet's CSP can't block it (AudioWorklet can).
    const processor = ctx.createScriptProcessor(STREAM.processorSize, 1, 1)
    const sink = ctx.createGain()
    sink.gain.value = 0
    source.connect(processor)
    processor.connect(sink)
    sink.connect(ctx.destination)

    const stream = {
      direction,
      source,
      processor,
      sink,
      resample: createResampler(ctx.sampleRate, STREAM.rate),
      pending: new Int16Array(STREAM.frameSamples),
      preroll: null,
      filled: 0,
      speaking: false,
      lastVoiceAt: -Infinity,
    }
    processor.onaudioprocess = (event) => handleStreamAudio(stream, event.inputBuffer.getChannelData(0))
    state.streams[direction] = stream
    log(`live ${direction} stream started (${ctx.sampleRate} Hz -> ${STREAM.rate} Hz)`)
    post("STATUS", { direction, state: "streaming" })
  }

  const stopStream = (direction, announce = true) => {
    const stream = state.streams[direction]
    if (!stream) return
    state.streams[direction] = null
    stream.processor.onaudioprocess = null
    if (direction === "outgoing") {
      stream.source.disconnect()
    } else {
      // The incoming mix is shared with other features; only unhook ourselves.
      stream.source.disconnect(stream.processor)
      releaseIncomingMix()
    }
    stream.processor.disconnect()
    stream.sink.disconnect()
    // The last partial frame holds the final syllables; send it too.
    if (stream.filled > 0) emitStreamFrame(stream, stream.pending.slice(0, stream.filled))
    if (announce) post("STATUS", { direction, state: "stream_stopped" })
  }

  // Gapless playback of streamed PCM16: each chunk is scheduled right after the previous one.
  const playPcm = async (direction, audioBase64, sampleRate) => {
    await resumeAudio()
    const ctx = state.audioCtx
    const pcm = new Int16Array(base64ToArrayBuffer(audioBase64))
    if (pcm.length === 0) return
    const floats = new Float32Array(pcm.length)
    let peak = 0
    for (let i = 0; i < pcm.length; i++) {
      const value = pcm[i] / 0x8000
      floats[i] = value
      if (value > peak) peak = value
      else if (-value > peak) peak = -value
    }

    if (!state.pcmPlayers[direction]) state.pcmPlayers[direction] = { nextTime: 0, active: false, doneTimer: null }
    const player = state.pcmPlayers[direction]
    const now = ctx.currentTime
    const backlog = player.nextTime - now
    if (peak < STREAM.silentPeak && (backlog <= 0 || backlog > STREAM.maxSilentBacklogS)) return

    const buffer = ctx.createBuffer(1, floats.length, Number(sampleRate) || STREAM.rate)
    buffer.copyToChannel(floats, 0)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(direction === "outgoing" ? state.virtualMicDest : ctx.destination)
    source.onended = () => source.disconnect()
    if (player.nextTime < now + 0.02) player.nextTime = now + STREAM.playbackLeadS
    source.start(player.nextTime)
    player.nextTime += buffer.duration

    if (!player.active) {
      player.active = true
      post("STATUS", { direction, state: "voice_on" })
    }
    window.clearTimeout(player.doneTimer)
    player.doneTimer = window.setTimeout(() => {
      player.active = false
      post("STATUS", { direction, state: "voice_off" })
    }, (player.nextTime - now) * 1000 + 150)
  }

  // ---------------------------------------------------------------------------
  // Playback
  // ---------------------------------------------------------------------------
  const base64ToArrayBuffer = (base64) => {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes.buffer
  }

  const duckMeetAudio = () => {
    state.duckCount += 1
    if (state.duckCount > 1) return
    getMeetAudioElements().forEach((el) => {
      state.duckedVolumes.set(el, el.volume)
      el.volume = Math.min(el.volume, DUCK_VOLUME)
    })
  }

  const restoreMeetAudio = () => {
    state.duckCount = Math.max(0, state.duckCount - 1)
    if (state.duckCount > 0) return
    state.duckedVolumes.forEach((volume, el) => { el.volume = volume })
    state.duckedVolumes.clear()
  }

  const playBuffer = (audioBuffer, destination) =>
    new Promise((resolve) => {
      const source = state.audioCtx.createBufferSource()
      source.buffer = audioBuffer
      source.connect(destination)
      source.onended = () => {
        source.disconnect()
        resolve()
      }
      source.start(0)
    })

  const playClip = async (direction, audioBase64) => {
    await resumeAudio()
    const audioBuffer = await state.audioCtx.decodeAudioData(base64ToArrayBuffer(audioBase64))

    if (direction === "outgoing") {
      post("STATUS", { direction, state: "playing" })
      await playBuffer(audioBuffer, state.virtualMicDest)
      post("STATUS", { direction, state: "played" })
      return
    }

    // Ducking also gates outgoing hands-free, so Bangla leaking from speakers
    // into the mic is never re-translated and sent to the meeting.
    duckMeetAudio()
    try {
      post("STATUS", { direction, state: "playing" })
      await playBuffer(audioBuffer, state.audioCtx.destination)
      post("STATUS", { direction, state: "played" })
    } finally {
      restoreMeetAudio()
    }
  }

  const enqueuePlayback = (direction, audioBase64) => {
    state.playQueues[direction] = state.playQueues[direction]
      .then(() => playClip(direction, audioBase64))
      .catch((err) => post("ERROR", { direction, message: `Playback failed: ${err.message}` }))
  }

  // ---------------------------------------------------------------------------
  // Messages from bridge.js
  // ---------------------------------------------------------------------------
  const isDirection = (value) => value === "outgoing" || value === "incoming"

  const reportError = (direction) => (err) => post("ERROR", { direction, message: err.message })

  const handleMessage = (event) => {
    if (event.source !== window) return
    const msg = event.data
    if (!msg || msg.source !== SOURCE || msg.target !== "inject") return

    if (msg.type === "HELLO") {
      postMicState()
      return
    }
    if (msg.type === "SETTINGS") {
      state.gateOnPlayback = Boolean(msg.gateOnPlayback)
      return
    }
    if (!isDirection(msg.direction)) return

    if (msg.type === "START_STREAM") {
      startStream(msg.direction).catch(reportError(msg.direction))
      return
    }
    if (msg.type === "STOP_STREAM") {
      stopStream(msg.direction)
      return
    }
    if (msg.type === "PCM_PLAY" && typeof msg.audioBase64 === "string" && msg.audioBase64.length > 0) {
      playPcm(msg.direction, msg.audioBase64, msg.sampleRate).catch(reportError(msg.direction))
      return
    }
    if (msg.type === "START_REC") {
      const start = msg.mode === "vad" ? startLive(msg.direction, msg.silenceMs) : startRecording(msg.direction)
      start.catch(reportError(msg.direction))
      return
    }
    if (msg.type === "STOP_REC") {
      if (state.live[msg.direction]) stopLive(msg.direction, true)
      else stopRecording(msg.direction)
      return
    }
    if (msg.type === "PLAY" && typeof msg.audioBase64 === "string" && msg.audioBase64.length > 0) {
      enqueuePlayback(msg.direction, msg.audioBase64)
    }
  }

  window.addEventListener("message", handleMessage)
  log("installed")
})()
