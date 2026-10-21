import { timingSafeEqual } from "node:crypto"
import { config } from "../config.js"

export const isAllowedOrigin = (origin: string | undefined): boolean => {
  if (!origin) return true
  if (config.allowedOrigins.length > 0) return config.allowedOrigins.includes(origin)
  return origin.startsWith("chrome-extension://")
}

export const tokensMatch = (provided: string, expected: string): boolean => {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
