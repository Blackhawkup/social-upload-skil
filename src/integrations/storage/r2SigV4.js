import crypto from 'node:crypto';

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function getSigningKey(secretAccessKey, dateStamp, region, service) {
  const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

function encodeRfc3986(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodePathSegments(objectKey) {
  return objectKey
    .split('/')
    .map((seg) => encodeRfc3986(seg))
    .join('/');
}

function formatAmzDate(date = new Date()) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8),
  };
}

function buildCanonicalQueryString(queryParams) {
  if (!queryParams || typeof queryParams !== 'object') return '';
  const entries = Object.entries(queryParams)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [encodeRfc3986(String(k)), encodeRfc3986(String(v))]);
  entries.sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return entries.map(([ek, ev]) => `${ek}=${ev}`).join('&');
}

export function buildSignedS3Headers({
  method,
  endpointUrl,
  bucket,
  objectKey = '',
  queryParams = null,
  accessKeyId,
  secretAccessKey,
  region = 'auto',
  contentType = 'application/octet-stream',
  payloadHash = 'UNSIGNED-PAYLOAD',
  now = new Date(),
}) {
  const base = new URL(endpointUrl);
  const { amzDate, dateStamp } = formatAmzDate(now);
  const cleanKey = String(objectKey || '').replace(/^\/+/, '');
  const basePath = `${base.pathname.replace(/\/$/, '')}/${encodeRfc3986(bucket)}`;
  const canonicalUri = cleanKey ? `${basePath}/${encodePathSegments(cleanKey)}` : basePath;
  const canonicalQuery = buildCanonicalQueryString(queryParams);
  const targetUrl = canonicalQuery ? `${base.origin}${canonicalUri}?${canonicalQuery}` : `${base.origin}${canonicalUri}`;

  const headersToSign = {
    host: base.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (contentType && (method === 'PUT' || method === 'POST')) {
    headersToSign['content-type'] = contentType;
  }

  const sortedKeys = Object.keys(headersToSign).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${String(headersToSign[k]).trim()}\n`).join('');
  const signedHeaders = sortedKeys.join(';');

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = getSigningKey(secretAccessKey, dateStamp, region, 's3');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url: targetUrl,
    headers: {
      ...headersToSign,
      Authorization: authorization,
    },
  };
}

export function createPresignedS3GetUrl({
  endpointUrl,
  bucket,
  objectKey,
  accessKeyId,
  secretAccessKey,
  region = 'auto',
  expiresSeconds = 1800,
  now = new Date(),
}) {
  const base = new URL(endpointUrl);
  const { amzDate, dateStamp } = formatAmzDate(now);
  const canonicalUri = `${base.pathname.replace(/\/$/, '')}/${encodeRfc3986(bucket)}/${encodePathSegments(objectKey)}`;
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;

  // Enforce short-lived presigned URLs (60s..3600s max = 1 hour)
  const clampedExpires = Math.min(Math.max(60, Math.floor(Number(expiresSeconds) || 1800)), 3600);

  const queryParams = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(clampedExpires),
    'X-Amz-SignedHeaders': 'host',
  };

  const canonicalQuery = Object.keys(queryParams)
    .sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(queryParams[k])}`)
    .join('&');

  const canonicalRequest = [
    'GET',
    canonicalUri,
    canonicalQuery,
    `host:${base.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = getSigningKey(secretAccessKey, dateStamp, region, 's3');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  return `${base.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

