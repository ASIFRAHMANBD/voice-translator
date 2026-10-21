import { config } from "../config.js"

export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    public readonly status?: number
  ) {
    super(`[${provider}] ${message}`)
    this.name = "ProviderError"
  }
}

const MAX_ERROR_BODY = 300

// fetch with a timeout that turns non-2xx responses into ProviderError with a
// truncated body, so upstream messages surface without leaking full payloads.
export const providerFetch = async (provider: string, url: string, init: RequestInit): Promise<Response> => {
  let res: Response
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(config.providerTimeoutMs) })
  } catch (err) {
    const reason = err instanceof Error && err.name === "TimeoutError" ? "request timed out" : "network error"
    throw new ProviderError(provider, reason)
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, MAX_ERROR_BODY)
    throw new ProviderError(provider, `HTTP ${res.status}${body ? `: ${body}` : ""}`, res.status)
  }
  return res
}

export const bearer = (key: string): Record<string, string> => (key ? { Authorization: `Bearer ${key}` } : {})

export const fileNameForMime = (mime: string): string => {
  if (mime.includes("ogg")) return "audio.ogg"
  if (mime.includes("wav")) return "audio.wav"
  if (mime.includes("mpeg") || mime.includes("mp3")) return "audio.mp3"
  if (mime.includes("mp4") || mime.includes("m4a")) return "audio.m4a"
  return "audio.webm"
}
