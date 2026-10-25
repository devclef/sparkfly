import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Firefly III signs webhooks with the header:
 *
 *   Signature: t=<unix timestamp>,v1=<hex>
 *
 * where v1 = HMAC-SHA3-256(secret, "<t>.<raw body>"). The body that is signed
 * is the exact JSON string that gets sent, so verification must run against
 * the raw request bytes, not a re-serialised parse.
 */

export interface SignatureParts {
  timestamp: number;
  v1: string;
}

export function parseSignatureHeader(header: string | undefined): SignatureParts | null {
  if (!header) return null;
  // Firefly sends "t=<unix>,v1=<hex>". Note: commas are not URLSearchParams
  // separators, so we split by hand.
  const values: Record<string, string> = {};
  for (const part of header.split(',')) {
    const idx = part.indexOf('=');
    if (idx <= 0) return null;
    values[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  const tRaw = values['t'];
  const v1 = values['v1'];
  if (!tRaw || !v1) return null;
  const timestamp = Number(tRaw);
  if (!Number.isInteger(timestamp)) return null;
  return { timestamp, v1 };
}

/** Compute the v1 signature value for a body (used by tests and tooling). */
export function signBody(secret: string, rawBody: string | Buffer, timestamp: number): string {
  return createHmac('sha3-256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

/** Build a ready-to-send `Signature` header value. */
export function signHeader(secret: string, rawBody: string | Buffer, timestamp = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${signBody(secret, rawBody, timestamp)}`;
}

export interface VerificationResult {
  ok: boolean;
  reason?: string;
}

export function verifyWebhookSignature(opts: {
  rawBody: Buffer;
  signatureHeader: string | undefined;
  secret: string;
  ttlSeconds: number;
  nowMs?: number;
}): VerificationResult {
  const nowMs = opts.nowMs ?? Date.now();
  const parsed = parseSignatureHeader(opts.signatureHeader);
  if (!parsed) {
    return { ok: false, reason: 'missing or malformed "Signature" header (expected "t=<unix>,v1=<hex>")' };
  }
  if (!/^[0-9a-f]{64}$/i.test(parsed.v1)) {
    return { ok: false, reason: 'malformed "v1" value in Signature header' };
  }
  const ageSeconds = Math.abs(nowMs / 1000 - parsed.timestamp);
  if (ageSeconds > opts.ttlSeconds) {
    return { ok: false, reason: `timestamp is ${Math.round(ageSeconds)}s off (tolerance ${opts.ttlSeconds}s)` };
  }
  const expected = signBody(opts.secret, opts.rawBody, parsed.timestamp);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(parsed.v1, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true };
}
