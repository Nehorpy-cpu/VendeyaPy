import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyMetaSignature } from './webhookSignature.js';
import { WebhookSignatureError } from '../lib/errors.js';

describe('verifyMetaSignature', () => {
  const secret = 'app-secret-de-prueba';
  const body = Buffer.from(JSON.stringify({ hello: 'world' }));
  const valid = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

  it('acepta una firma válida', () => {
    expect(() => verifyMetaSignature(body, valid, secret)).not.toThrow();
  });

  it('rechaza una firma inválida', () => {
    expect(() => verifyMetaSignature(body, 'sha256=deadbeef', secret)).toThrow(WebhookSignatureError);
  });

  it('rechaza si falta la firma', () => {
    expect(() => verifyMetaSignature(body, undefined, secret)).toThrow(WebhookSignatureError);
  });

  it('rechaza una firma sin el prefijo sha256=', () => {
    const hex = createHmac('sha256', secret).update(body).digest('hex');
    expect(() => verifyMetaSignature(body, hex, secret)).toThrow(WebhookSignatureError);
  });

  it('rechaza un body manipulado (misma firma)', () => {
    const tampered = Buffer.from(JSON.stringify({ hello: 'evil' }));
    expect(() => verifyMetaSignature(tampered, valid, secret)).toThrow(WebhookSignatureError);
  });
});
