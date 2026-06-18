import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMetaWebhookPayload } from './parseWebhook.js';

// src/meta → ../../../../ = 10-backend, luego tests/fixtures/whatsapp-payloads
const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'tests', 'fixtures', 'whatsapp-payloads');
const load = (name: string) => JSON.parse(readFileSync(join(FIX, name), 'utf8'));

describe('parseMetaWebhookPayload', () => {
  it('WhatsApp texto → 1 mensaje normalizado', () => {
    const r = parseMetaWebhookPayload(load('incoming-text.json'));
    expect(r.messages).toHaveLength(1);
    const m = r.messages[0]!;
    expect(m).toMatchObject({
      platform: 'whatsapp',
      externalId: 'PHONE_NUMBER_ID',
      from: '595991234567',
      text: 'hola',
      messageId: 'wamid.HBgNNTk1OTkxMjM0NTY3FQIAEhggMzc2RDI0ODI',
    });
    expect(m.timestamp).toBe(1716750000);
    expect(m.adReferral).toBeNull();
  });

  it('WhatsApp interactive (button_reply) → texto = título del botón', () => {
    const r = parseMetaWebhookPayload(load('incoming-interactive-button.json'));
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]!.text).toBe('Agregar al carrito');
  });

  it('WhatsApp con referral de anuncio → adReferral.adId (sin campaignId)', () => {
    const r = parseMetaWebhookPayload(load('wa-referral.json'));
    expect(r.messages[0]!.adReferral).toMatchObject({ adId: '120211234567890123', campaignId: null, sourceUrl: 'https://fb.me/2abcXyz' });
  });

  it('WhatsApp imagen (no-texto) → ignorado', () => {
    const r = parseMetaWebhookPayload(load('wa-image.json'));
    expect(r.messages).toHaveLength(0);
    expect(r.ignored).toBe(1);
  });

  it('WhatsApp status (recibo de entrega) → ignorado', () => {
    const r = parseMetaWebhookPayload(load('wa-status.json'));
    expect(r.messages).toHaveLength(0);
    expect(r.ignored).toBe(1);
  });

  it('WhatsApp multi-mensaje → 2 normalizados', () => {
    const r = parseMetaWebhookPayload(load('wa-multi.json'));
    expect(r.messages).toHaveLength(2);
    expect(r.messages.map((m) => m.text)).toEqual(['hola', 'buenas']);
  });

  it('Instagram → 1 mensaje (entry.id como externalId, sender.id, message.mid)', () => {
    const r = parseMetaWebhookPayload(load('ig-text.json'));
    expect(r.messages[0]).toMatchObject({ platform: 'instagram', externalId: 'IG_ACCOUNT_ID', from: 'IGSID_123', text: 'hola por instagram', messageId: 'mid.IG1' });
  });

  it('Messenger → 1 mensaje (entry.id PAGE_ID, sender.id PSID, message.mid)', () => {
    const r = parseMetaWebhookPayload(load('messenger-text.json'));
    expect(r.messages[0]).toMatchObject({ platform: 'messenger', externalId: 'PAGE_ID', from: 'PSID_123', text: 'hola por messenger', messageId: 'mid.MSGR1' });
  });

  it('malformado / vacío / no-objeto → 0 mensajes, NO lanza', () => {
    expect(() => parseMetaWebhookPayload(load('malformed.json'))).not.toThrow();
    expect(parseMetaWebhookPayload(load('malformed.json')).messages).toHaveLength(0);
    expect(parseMetaWebhookPayload({}).messages).toHaveLength(0);
    expect(parseMetaWebhookPayload(null).messages).toHaveLength(0);
    expect(parseMetaWebhookPayload('basura').messages).toHaveLength(0);
    expect(parseMetaWebhookPayload({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: {} }] }] }).messages).toHaveLength(0);
  });
});
