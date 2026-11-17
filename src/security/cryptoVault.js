import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

export function deriveSubKey(masterKey, context, salt) {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== KEY_BYTES) {
    throw new Error('Master key must be a 32-byte Buffer');
  }
  const derived = crypto.hkdfSync(
    'sha256',
    masterKey,
    salt,
    Buffer.from(String(context), 'utf8'),
    KEY_BYTES
  );
  return Buffer.from(derived);
}

export function encryptPayload(masterKey, context, payloadObj, aadString) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const derivedKey = deriveSubKey(masterKey, context, salt);

  try {
    const cipher = crypto.createCipheriv(ALGORITHM, derivedKey, iv);
    const aad = String(aadString || context);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const plaintext = Buffer.from(JSON.stringify(payloadObj), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      v: 1,
      alg: 'AES-256-GCM',
      kdf: 'HKDF-SHA256',
      context,
      aad,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      ct: ciphertext.toString('base64'),
    };
  } finally {
    derivedKey.fill(0);
  }
}

export function decryptPayload(masterKey, context, envelope, expectedAadString) {
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('Invalid encrypted payload envelope');
  }
  if (envelope.v !== 1 || envelope.alg !== 'AES-256-GCM' || envelope.kdf !== 'HKDF-SHA256') {
    throw new Error('Unsupported encrypted payload version or algorithm');
  }
  const expectedAad = String(expectedAadString || context);
  if (envelope.context !== context || envelope.aad !== expectedAad) {
    throw new Error('Encrypted payload context or AAD mismatch');
  }

  const salt = Buffer.from(envelope.salt, 'base64');
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const ciphertext = Buffer.from(envelope.ct, 'base64');
  const derivedKey = deriveSubKey(masterKey, context, salt);

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, derivedKey, iv);
    decipher.setAAD(Buffer.from(expectedAad, 'utf8'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
  } finally {
    derivedKey.fill(0);
  }
}

