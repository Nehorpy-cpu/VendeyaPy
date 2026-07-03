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

  it('ORDER-1B: WhatsApp imagen → normalizada con image.mediaId (posible comprobante)', () => {
    const r = parseMetaWebhookPayload(load('wa-image.json'));
    expect(r.messages).toHaveLength(1);
    expect(r.ignored).toBe(0);
    const m = r.messages[0]!;
    expect(m.image).toEqual({ mediaId: 'MEDIA_ID', mimeType: 'image/jpeg', caption: null });
    expect(m.text).toBe(''); // sin caption → text vacío (el flujo de comprobante no depende del texto)
    expect(m.from).toBe('595991234567');
    expect(m.messageId).toBe('wamid.IMG1');
  });

  it('ORDER-1B: imagen SIN media id → ignorada; caption → text', () => {
    const base = load('wa-image.json');
    base.entry[0].changes[0].value.messages[0].image = { mime_type: 'image/jpeg' }; // sin id
    expect(parseMetaWebhookPayload(base).ignored).toBe(1);

    const conCaption = load('wa-image.json');
    conCaption.entry[0].changes[0].value.messages[0].image.caption = 'pago del pedido';
    const r = parseMetaWebhookPayload(conCaption);
    expect(r.messages[0]!.text).toBe('pago del pedido');
    expect(r.messages[0]!.image?.caption).toBe('pago del pedido');
  });

  it('ORDER-1B: otros media (audio/documento) siguen ignorados', () => {
    const base = load('wa-image.json');
    base.entry[0].changes[0].value.messages[0] = { from: '595991234567', id: 'wamid.AUDIO1', timestamp: '1716750300', type: 'audio', audio: { id: 'M2' } };
    const r = parseMetaWebhookPayload(base);
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
