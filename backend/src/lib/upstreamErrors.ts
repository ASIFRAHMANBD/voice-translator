// Errors that will never succeed on a retry: bad credentials, no quota, no
// credit. The live sessions must fail fast instead of reconnecting in a loop.
const FATAL_UPSTREAM_PATTERNS: RegExp[] = [
  // HTTP 401/403/404 from the upstream.
  /\b(401|403|404)\b/,
  // "You have no credits remaining", "insufficient_quota", "billing".
  /no credits remaining/i,
  /insufficient[_ ]quota/i,
  /credit_balance_exhausted/i,
  /billing/i,
  // Missing or invalid key.
  /invalid[_ ]api[_ ]key/i,
  /incorrect api key/i,
  /no api key/i,
  // The model is not available to this account.
  /model[_ ]not[_ ]found/i,
  /does not have access to/i,
  /unknown model/i,
]

// A fatal error means the same thing on a retry, so the session should stop
// instead of reconnecting and showing "Reconnecting (try N)".
export const isFatalUpstreamError = (message: string): boolean => {
  if (!message) return false
  return FATAL_UPSTREAM_PATTERNS.some((pattern) => pattern.test(message))
}
