import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMetaWebhookPayload, deliveryStatusesFromInboxPayload } from './parseWebhook.js';

/**
 * ADR-0021 §1 — LOS RECIBOS DE ENTREGA (`value.statuses`) DEJAN DE DESCARTARSE.
 * =============================================================================
 * Hasta este programa, todo `value.statuses` sumaba a `ignored` y el panel no podía mostrar
 * ticks honestos. Este archivo fija el contrato del parser:
 *  - los cuatro estados del proveedor (sent/delivered/read/failed) salen como eventos TIPADOS;
 *  - un estado que este despliegue no conoce se descarta contado (no se degrada a uno conocido);
 *  - el error de un `failed` viaja SANEADO (code + title/message) y JAMÁS el payload crudo;
 *  - `contacts[].profile.name` se asocia al mensaje entrante por `wa_id` (perfil honesto, §2).
 */

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'tests', 'fixtures', 'whatsapp-payloads');
const load = (name: string) => JSON.parse(readFileSync(join(FIX, name), 'utf8'));

const conStatuses = (statuses: unknown, metadata: unknown = { phone_number_id: 'PNID_1' }) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata, statuses } }] }],
});

describe('parseMetaWebhookPayload — recibos de entrega (ADR-0021)', () => {
  it('el fixture wa-status.json ya NO se descarta: sale como evento tipado', () => {
    const r = parseMetaWebhookPayload(load('wa-status.json'));
    expect(r.messages).toHaveLength(0);
    expect(r.ignored).toBe(0); // antes: 1 — el recibo se tiraba
    expect(r.deliveryStatuses).toHaveLength(1);
    expect(r.deliveryStatuses[0]).toEqual({
      waMessageId: 'wamid.OUT1',
      status: 'delivered',
      timestampSeconds: 1716750400,
      recipientId: '595991234567',
      receivedVia: 'PHONE_NUMBER_ID',
    });
  });

  it('sent / delivered / read / failed se normalizan; el orden del lote se conserva', () => {
    const r = parseMetaWebhookPayload(conStatuses([
      { id: 'wamid.A', status: 'sent', timestamp: '100', recipient_id: '595991' },
      { id: 'wamid.A', status: 'delivered', timestamp: '200', recipient_id: '595991' },
      { id: 'wamid.A', status: 'read', timestamp: '300', recipient_id: '595991' },
      { id: 'wamid.B', status: 'failed', timestamp: '400', recipient_id: '595992' },
    ]));
    expect(r.ignored).toBe(0);
    expect(r.deliveryStatuses.map((s) => s.status)).toEqual(['sent', 'delivered', 'read', 'failed']);
    expect(r.deliveryStatuses.map((s) => s.timestampSeconds)).toEqual([100, 200, 300, 400]);
    expect(r.deliveryStatuses[0]!.receivedVia).toBe('PNID_1');
  });

  it('un estado DESCONOCIDO se descarta contado — jamás se degrada a uno conocido', () => {
    const r = parseMetaWebhookPayload(conStatuses([
      { id: 'wamid.A', status: 'warning', timestamp: '100', recipient_id: '595991' },
      { id: 'wamid.B', status: 'delivered', timestamp: '200', recipient_id: '595991' },
    ]));
    expect(r.deliveryStatuses).toHaveLength(1);
    expect(r.deliveryStatuses[0]!.status).toBe('delivered');
    expect(r.ignored).toBe(1);
  });

  it('sin wamid o sin recipient_id no hay a qué aplicarlo: se descarta contado', () => {
    const r = parseMetaWebhookPayload(conStatuses([
      { status: 'delivered', timestamp: '100', recipient_id: '595991' }, // sin id
      { id: 'wamid.A', status: 'delivered', timestamp: '100' }, // sin recipient_id
    ]));
    expect(r.deliveryStatuses).toHaveLength(0);
    expect(r.ignored).toBe(2);
  });

  it('el error de un failed viaja SANEADO (code + title), sin el payload crudo', () => {
    const r = parseMetaWebhookPayload(conStatuses([{
      id: 'wamid.F', status: 'failed', timestamp: '500', recipient_id: '595991',
      errors: [{
        code: 131047,
        title: 'Re-engagement message',
        message: 'Re-engagement message',
        error_data: { details: 'Message failed to send because more than 24 hours have passed +595991234567' },
      }],
    }]));
    const ev = r.deliveryStatuses[0]!;
    expect(ev.error).toEqual({ code: '131047', detail: 'Re-engagement message' });
    // El payload crudo del error (error_data / details) NO se transporta: puede traer contenido.
    expect(JSON.stringify(ev)).not.toContain('error_data');
    expect(JSON.stringify(ev)).not.toContain('24 hours');
  });

  it('error sin title cae a message, saneado: sin corridas largas de dígitos ni URLs', () => {
    const r = parseMetaWebhookPayload(conStatuses([{
      id: 'wamid.F', status: 'failed', timestamp: '500', recipient_id: '595991',
      errors: [{ code: 470, message: 'No se pudo entregar a 595991234567 via https://graph.facebook.com/x' }],
    }]));
    const detail = r.deliveryStatuses[0]!.error?.detail ?? '';
    expect(detail).not.toContain('595991234567');
    expect(detail).not.toContain('graph.facebook.com');
    expect(r.deliveryStatuses[0]!.error?.code).toBe('470');
  });

  it('failed sin errors[] queda sin `error` (no se inventa detalle)', () => {
    const r = parseMetaWebhookPayload(conStatuses([
      { id: 'wamid.F', status: 'failed', timestamp: '500', recipient_id: '595991' },
    ]));
    expect(r.deliveryStatuses[0]!.error).toBeUndefined();
  });

  it('timestamp ausente o basura ⇒ null (nunca se inventa reloj); metadata ausente ⇒ receivedVia vacío', () => {
    const r = parseMetaWebhookPayload(conStatuses(
      [{ id: 'wamid.A', status: 'read', recipient_id: '595991', timestamp: 'zzz' }],
      null, // sin metadata (null esquiva el default del helper: undefined lo activaría)
    ));
    expect(r.deliveryStatuses[0]!.timestampSeconds).toBeNull();
    expect(r.deliveryStatuses[0]!.receivedVia).toBe('');
  });

  it('statuses malformado (no-array / basura adentro) no lanza y no inventa eventos', () => {
    expect(() => parseMetaWebhookPayload(conStatuses('no-array'))).not.toThrow();
    expect(parseMetaWebhookPayload(conStatuses('no-array')).deliveryStatuses).toHaveLength(0);
    const r = parseMetaWebhookPayload(conStatuses([null, 42, {}]));
    expect(r.deliveryStatuses).toHaveLength(0);
    expect(r.ignored).toBe(3);
  });
});

describe('parseMetaWebhookPayload — profileName del contacto (ADR-0021 §2)', () => {
  const conContacto = (name: unknown, waId = '595991234567') => {
    const base = load('incoming-text.json');
    base.entry[0].changes[0].value.contacts = [{ wa_id: waId, profile: { name } }];
    return base;
  };

  it('contacts[].profile.name se asocia al mensaje entrante por wa_id', () => {
    const r = parseMetaWebhookPayload(conContacto('Coti Fernández'));
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]!.profileName).toBe('Coti Fernández');
  });

  it('sin contacto que matchee el `from`, el mensaje queda SIN profileName (no se adivina)', () => {
    const r = parseMetaWebhookPayload(conContacto('Otra Persona', '595990000000'));
    expect(r.messages[0]!.profileName).toBeUndefined();
    // Y un payload SIN `contacts` (Meta no siempre los manda) queda sin profileName.
    const sinContacts = load('incoming-text.json');
    delete sinContacts.entry[0].changes[0].value.contacts;
    expect(parseMetaWebhookPayload(sinContacts).messages[0]!.profileName).toBeUndefined();
  });

  it('el fixture real de Meta (incoming-text.json) trae contacts: el mensaje sale con profileName', () => {
    expect(parseMetaWebhookPayload(load('incoming-text.json')).messages[0]!.profileName).toBe('Cliente de Prueba');
  });

  it('nombre hostil llega SANEADO (sin control chars, sin invisibles, acotado)', () => {
    const r = parseMetaWebhookPayload(conContacto(`  Coti‮\n${'x'.repeat(500)}  `));
    const name = r.messages[0]!.profileName!;
    expect(name.startsWith('Coti')).toBe(true);
    expect(name).not.toContain('\n');
    expect(name).not.toContain('‮');
    expect(name.length).toBeLessThanOrEqual(128);
  });

  it('nombre vacío o no-string ⇒ sin profileName', () => {
    expect(parseMetaWebhookPayload(conContacto('   ')).messages[0]!.profileName).toBeUndefined();
    expect(parseMetaWebhookPayload(conContacto(42)).messages[0]!.profileName).toBeUndefined();
  });
});

describe('deliveryStatusesFromInboxPayload — mapper del payload YA persistido en el inbox', () => {
  it('acepta la forma que escribe el productor y re-valida cada evento', () => {
    const eventos = deliveryStatusesFromInboxPayload({
      statuses: [
        { waMessageId: 'wamid.A', status: 'delivered', timestampSeconds: 100, recipientId: '595991', receivedVia: 'PNID_1' },
        { waMessageId: 'wamid.F', status: 'failed', timestampSeconds: null, recipientId: '595992', receivedVia: 'PNID_1', error: { code: '470', detail: 'x' } },
      ],
    });
    expect(eventos).toHaveLength(2);
    expect(eventos[0]).toEqual({ waMessageId: 'wamid.A', status: 'delivered', timestampSeconds: 100, recipientId: '595991', receivedVia: 'PNID_1' });
    expect(eventos[1]!.error).toEqual({ code: '470', detail: 'x' });
  });

  it('descarta lo inválido sin lanzar: estado desconocido, sin wamid, sin recipient, basura', () => {
    expect(deliveryStatusesFromInboxPayload({
      statuses: [
        { waMessageId: 'wamid.A', status: 'inventado', recipientId: '595991', receivedVia: '' },
        { status: 'read', recipientId: '595991', receivedVia: '' },
        { waMessageId: 'wamid.B', status: 'read', receivedVia: '' },
        null,
      ],
    })).toHaveLength(0);
    expect(deliveryStatusesFromInboxPayload({})).toHaveLength(0);
    expect(deliveryStatusesFromInboxPayload(null)).toHaveLength(0);
    expect(deliveryStatusesFromInboxPayload({ statuses: 'no-array' })).toHaveLength(0);
  });
});
