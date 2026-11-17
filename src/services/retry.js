export const HARD_MAX_RETRY_ATTEMPTS = 5;
export const HARD_MAX_RETRY_DELAY_MS = 60_000;

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PlatformError extends Error {
  constructor(
    message,
    { code = 'PLATFORM_ERROR', statusCode = 500, retryable = false, retryAfterMs = null, details = null } = {}
  ) {
    super(message);
    this.name = 'PlatformError';
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.details = details;
  }
}

export function parseRetryAfterMs(headers) {
  if (!headers) return null;
  const val = typeof headers.get === 'function' ? headers.get('retry-after') : headers['retry-after'];
  if (!val) return null;
  const sec = Number(val);
  if (!Number.isNaN(sec) && sec >= 0) {
    return Math.min(sec * 1000, HARD_MAX_RETRY_DELAY_MS);
  }
  const dateMs = new Date(val).getTime();
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, Math.min(dateMs - Date.now(), HARD_MAX_RETRY_DELAY_MS));
  }
  return null;
}

export async function withExponentialBackoff(
  fn,
  {
    maxAttempts = 4,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    shouldRetry = (err) => Boolean(err?.retryable),
    onRetry = null,
    sleepFn = sleep,
  } = {}
) {
  // Never retry indefinitely: hard-cap both attempt count and delay ceiling
  const numericAttempts = Number(maxAttempts);
  const boundedAttempts = Number.isFinite(numericAttempts)
    ? Math.min(HARD_MAX_RETRY_ATTEMPTS, Math.max(1, Math.floor(numericAttempts)))
    : HARD_MAX_RETRY_ATTEMPTS;

  const numericBaseDelay = Number(baseDelayMs);
  const safeBaseDelay = Number.isFinite(numericBaseDelay) && numericBaseDelay >= 0 ? numericBaseDelay : 1000;
  const numericMaxDelay = Number(maxDelayMs);
  const safeMaxDelay = Number.isFinite(numericMaxDelay)
    ? Math.min(HARD_MAX_RETRY_DELAY_MS, Math.max(0, numericMaxDelay))
    : HARD_MAX_RETRY_DELAY_MS;

  let lastError;
  for (let attempt = 1; attempt <= boundedAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt >= boundedAttempts || !shouldRetry(err, attempt)) {
        throw err;
      }
      const jitter = safeBaseDelay === 0 ? 0 : Math.floor(Math.random() * Math.min(250, Math.max(1, safeBaseDelay)));
      const exponential = Math.min(safeMaxDelay, safeBaseDelay * 2 ** (attempt - 1) + jitter);
      const delayMs = err?.retryAfterMs
        ? Math.min(HARD_MAX_RETRY_DELAY_MS, Math.max(err.retryAfterMs, safeBaseDelay))
        : exponential;
      if (onRetry) {
        onRetry({ attempt, maxAttempts: boundedAttempts, delayMs, error: err });
      }
      await sleepFn(delayMs);
    }
  }
  throw lastError;
}

