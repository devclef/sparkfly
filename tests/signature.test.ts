import { describe, expect, it } from 'vitest';
import { parseSignatureHeader, signBody, signHeader, verifyWebhookSignature } from '../src/firefly/signature.js';

const body = JSON.stringify({ hello: 'world' });
const secret = 's3cret';

describe('parseSignatureHeader', () => {
  it('parses t and v1', () => {
    expect(parseSignatureHeader('t=1234567890,v1=ab12cd')).toEqual({ timestamp: 1234567890, v1: 'ab12cd' });
  });
  it('rejects garbage', () => {
    expect(parseSignatureHeader(undefined)).toBeNull();
    expect(parseSignatureHeader('')).toBeNull();
    expect(parseSignatureHeader('v1=ab')).toBeNull();
    expect(parseSignatureHeader('t=abc,v1=ab')).toBeNull();
  });
});

describe('verifyWebhookSignature', () => {
  const now = 1_700_000_000_000;

  it('accepts a valid signature', () => {
    const header = signHeader(secret, body, Math.floor(now / 1000));
    expect(verifyWebhookSignature({ rawBody: Buffer.from(body), signatureHeader: header, secret, ttlSeconds: 300, nowMs: now })).toEqual({ ok: true });
  });

  it('rejects a tampered body', () => {
    const header = signHeader(secret, body, Math.floor(now / 1000));
    const res = verifyWebhookSignature({ rawBody: Buffer.from(body + ' '), signatureHeader: header, secret, ttlSeconds: 300, nowMs: now });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('signature mismatch');
  });

  it('rejects a wrong secret', () => {
    const header = signHeader('other-secret', body, Math.floor(now / 1000));
    const res = verifyWebhookSignature({ rawBody: Buffer.from(body), signatureHeader: header, secret, ttlSeconds: 300, nowMs: now });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('signature mismatch');
  });

  it('rejects stale timestamps beyond the ttl', () => {
    const t = Math.floor(now / 1000) - 600;
    const header = signHeader(secret, body, t);
    const res = verifyWebhookSignature({ rawBody: Buffer.from(body), signatureHeader: header, secret, ttlSeconds: 300, nowMs: now });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('timestamp is 600s off');
  });

  it('accepts timestamps within the ttl (both directions)', () => {
    const t = Math.floor(now / 1000) + 120;
    const header = signHeader(secret, body, t);
    expect(
      verifyWebhookSignature({ rawBody: Buffer.from(body), signatureHeader: header, secret, ttlSeconds: 300, nowMs: now }).ok,
    ).toBe(true);
  });

  it('rejects missing or malformed headers', () => {
    const base = { rawBody: Buffer.from(body), secret, ttlSeconds: 300, nowMs: now };
    expect(verifyWebhookSignature({ ...base, signatureHeader: undefined }).ok).toBe(false);
    expect(verifyWebhookSignature({ ...base, signatureHeader: 'nonsense' }).ok).toBe(false);
    expect(verifyWebhookSignature({ ...base, signatureHeader: 't=123' }).ok).toBe(false);
    const badV1 = `t=${Math.floor(now / 1000)},v1=nothex`;
    expect(verifyWebhookSignature({ ...base, signatureHeader: badV1 }).reason).toContain('malformed');
  });

  it('signBody matches an independent HMAC-SHA3-256 computation', () => {
    const crypto = require('node:crypto');
    const expected = crypto.createHmac('sha3-256', secret).update(`99.${body}`).digest('hex');
    expect(signBody(secret, body, 99)).toBe(expected);
  });
});
