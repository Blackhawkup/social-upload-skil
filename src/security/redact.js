const SENSITIVE_KEY_PATTERN =
  /^(access_?token|refresh_?token|id_?token|client_?secret|app_?secret|secret_?access_?key|api_?key|authorization|cookie|set-cookie|csrf|csrf_?token|csrf_?secret|master_?key|code_?verifier|passcode|password|ipc_?secret|bearer|token|secret|resumable_?session_?uri|x-api-key)$/i;

const SECRET_VALUE_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /ya29\.[A-Za-z0-9._-]{15,}/g,
  /1\/\/[A-Za-z0-9._-]{15,}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /EAA[A-Za-z0-9]{20,}/g,
  /IGAA[A-Za-z0-9._-]{20,}/g,
  /IGQ[A-Za-z0-9._-]{20,}/g,
  /([?&](?:access_token|refresh_token|fb_exchange_token|input_token|client_secret|code|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token)=)[^&\s"']+/gi,
];

const registeredSecrets = new Set();

export function registerSensitiveValue(value) {
  if (typeof value === 'string' && value.length >= 8) {
    registeredSecrets.add(value);
  }
}

export function clearRegisteredSensitiveValues() {
  registeredSecrets.clear();
}

export function maskSecret(value) {
  if (!value || typeof value !== 'string') return '';
  if (value.length <= 6) return '******';
  return `${'*'.repeat(Math.min(12, value.length - 4))}${value.slice(-4)}`;
}

export function redactString(input) {
  if (typeof input !== 'string') return input;
  let output = input;

  for (const pattern of SECRET_VALUE_PATTERNS) {
    output = output.replace(pattern, (match, prefix) => {
      if (prefix) return `${prefix}[REDACTED]`;
      return '[REDACTED]';
    });
  }

  for (const secret of registeredSecrets) {
    if (secret && output.includes(secret)) {
      output = output.split(secret).join('[REDACTED]');
    }
  }

  return output;
}

export function redactValue(value, depth = 0) {
  if (depth > 8 || value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Buffer.isBuffer(value)) return '[REDACTED_BUFFER]';
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message || ''),
      code: value.code,
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const clean = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        clean[k] = v ? '[REDACTED]' : '';
      } else {
        clean[k] = redactValue(v, depth + 1);
      }
    }
    return clean;
  }
  return String(value);
}

export function sanitizeErrorMessage(err, fallback = 'An internal error occurred') {
  if (!err) return fallback;
  const raw = typeof err === 'string' ? err : err.message || fallback;
  const redacted = redactString(raw);
  // Strip Windows/local stack traces if accidentally embedded
  const singleLine = redacted.split(/\r?\n/)[0].slice(0, 400);
  return singleLine || fallback;
}

