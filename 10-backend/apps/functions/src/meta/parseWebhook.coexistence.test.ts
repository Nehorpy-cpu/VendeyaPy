/**
 * parseWebhook.coexistence.test.ts — El despachador por `change.field` (ADR-0017 §12)
 * ===================================================================================
 * Hasta este programa, `parseWhatsApp` NUNCA leía `change.field`: buscaba `value.messages` en
 * cualquier cambio y devolvía cero para todo lo demás. Los tres eventos que hacen posible
 * Coexistence —`smb_message_echoes`, `history`, `smb_app_state_sync`— se descartaban sin dejar
 * rastro, y el sistema no se enteraba de que el vendedor estaba contestando desde su teléfono.
 *
 * El test más importante del archivo es el del `from` del echo. En un echo, `from` es el número
 * del NEGOCIO y `to` el del cliente (referencia oficial de `smb_message_echoes`, consultada
 * 2026-08-03). Normalizarlo con la forma de un inbound haría que `process.ts:249`
 * (`customerId = payload.from`) abriera una conversación de la perfumería consigo misma y el bot
 * se respondiera a sí mismo, sobre el número real y consumiendo cuota. Por eso acá no alcanza con
 * "el campo se llama distinto": se verifica que el número del negocio NO APAREZCA EN NINGÚN LADO
 * de la forma normalizada.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMetaWebhookPayload, echoIdempotencyKey } from './parseWebhook.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'tests', 'fixtures', 'whatsapp-payloads');
const load = (name: string) => JSON.parse(readFileSync(join(FIX, name), 'utf8'));

/** El número del NEGOCIO (la perfumería). En un echo llega como `from`: JAMÁS se transporta. */
const NEGOCIO = '595990000001';
/** El número del CLIENTE. En un echo llega como `to`: es de ahí de donde sale la identidad. */
const CLIENTE = '595991234567';
/** Canal: el `phone_number_id` del número que emitió. Es lo único que identifica el canal. */
const PNID = 'PNID_DEL_NUMERO_REAL';

const cambio = (field: string, value: unknown) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA_ID', changes: [{ field, value }] }],
});

const metadata = { display_phone_number: NEGOCIO, phone_number_id: PNID };

const echoPayload = (...items: unknown[]) =>
  cambio('smb_message_echoes', { messaging_product: 'whatsapp', metadata, message_echoes: items });

const echoTexto = (over: Record<string, unknown> = {}) => ({
  from: NEGOCIO,
  to: CLIENTE,
  id: 'wamid.ECHO1',
  timestamp: '1754200000',
  type: 'text',
  text: { body: 'te lo dejo reservado' },
  ...over,
});

describe('despachador por change.field — smb_message_echoes', () => {
  it('un echo de texto NO entra como inbound: sale por su propia lista', () => {
    const r = parseMetaWebhookPayload(echoPayload(echoTexto()));
    expect(r.messages).toHaveLength(0); // el motor nunca lo ve como mensaje del cliente
    expect(r.echoes).toHaveLength(1);
    const e = r.echoes[0]!;
    expect(e.platform).toBe('whatsapp');
    expect(e.externalId).toBe(PNID); // el canal sale de metadata.phone_number_id
    expect(e.customerWaId).toBe(CLIENTE); // …y el cliente, de `to`
    expect(e.messageId).toBe('wamid.ECHO1');
    expect(e.text).toBe('te lo dejo reservado');
    expect(e.timestamp).toBe(1754200000);
    expect(e.echoType).toBe('text');
    expect(e.automationEligible).toBe(false);
  });

  it('LA REGLA DURA: el `from` del echo (el número del NEGOCIO) no viaja en NINGÚN campo', () => {
    const r = parseMetaWebhookPayload(echoPayload(echoTexto()));
    const e = r.echoes[0]! as unknown as Record<string, unknown>;
    expect('from' in e).toBe(false);
    // Ni por un campo con otro nombre, ni por un crudo sin redactar, ni por el display_phone_number
    // que viene en metadata: si el número del negocio aparece, `customerId = payload.from` puede
    // volver a apuntar a la perfumería y el bot se contesta a sí mismo.
    expect(JSON.stringify(r.echoes)).not.toContain(NEGOCIO);
  });

  it('revoke (mensaje borrado por el vendedor) → tipado y NO automatizable', () => {
    const r = parseMetaWebhookPayload(
      echoPayload(echoTexto({ id: 'wamid.ECHO_RV', type: 'revoke', text: undefined, revoke: { original_message_id: 'wamid.ORIG1' } })),
    );
    expect(r.echoes).toHaveLength(1);
    expect(r.echoes[0]!.echoType).toBe('revoke');
    expect(r.echoes[0]!.originalMessageId).toBe('wamid.ORIG1');
    expect(r.echoes[0]!.text).toBe('');
    expect(r.echoes[0]!.automationEligible).toBe(false);
  });

  it('edit (mensaje editado) → tipado, con el original y el texto nuevo', () => {
    const r = parseMetaWebhookPayload(
      echoPayload(echoTexto({
        id: 'wamid.ECHO_ED', type: 'edit', text: undefined,
        edit: { original_message_id: 'wamid.ORIG2', message: { type: 'text', text: { body: 'son 250.000, no 150.000' } } },
      })),
    );
    expect(r.echoes[0]!.echoType).toBe('edit');
    expect(r.echoes[0]!.originalMessageId).toBe('wamid.ORIG2');
    expect(r.echoes[0]!.text).toBe('son 250.000, no 150.000');
  });

  it('echo de imagen → se registra el tipo de media, sin pretender descargarlo', () => {
    const r = parseMetaWebhookPayload(
      echoPayload(echoTexto({ id: 'wamid.ECHO_IMG', type: 'image', text: undefined, image: { id: 'MEDIA_X', mime_type: 'image/jpeg', caption: 'la promo' } })),
    );
    expect(r.echoes[0]!.echoType).toBe('media');
    expect(r.echoes[0]!.mediaKind).toBe('image');
    expect(r.echoes[0]!.text).toBe(''); // el caption no se promueve a texto (ADR-0016 §9)
  });

  it('echo sin `to` o sin wamid → ignorado (no hay a quién atribuirlo ni cómo deduplicarlo)', () => {
    const r = parseMetaWebhookPayload(
      echoPayload(echoTexto({ to: undefined }), echoTexto({ id: undefined }), echoTexto({ id: 'wamid.OK' })),
    );
    expect(r.echoes).toHaveLength(1);
    expect(r.echoes[0]!.messageId).toBe('wamid.OK');
    expect(r.ignored).toBe(2);
  });

  it('la clave de idempotencia del echo NO colisiona con la de un mensaje vivo del mismo wamid', () => {
    const [texto] = parseMetaWebhookPayload(echoPayload(echoTexto({ id: 'wamid.MISMO' }))).echoes;
    const [revoke] = parseMetaWebhookPayload(
      echoPayload(echoTexto({ id: 'wamid.MISMO', type: 'revoke', text: undefined, revoke: { original_message_id: 'x' } })),
    ).echoes;
    expect(echoIdempotencyKey(texto!)).not.toBe('wamid.MISMO');
    expect(echoIdempotencyKey(texto!)).toContain('wamid.MISMO');
    // Un revoke del mismo wamid es OTRO hecho: si compartiera clave, el borrado se tragaría como
    // duplicado del mensaje original y el vendedor vería el mensaje que ya borró.
    expect(echoIdempotencyKey(revoke!)).not.toBe(echoIdempotencyKey(texto!));
  });
});

describe('despachador por change.field — history', () => {
  const historyPayload = (threads: unknown[], meta: Record<string, unknown> = { phase: 0, chunk_order: 1, progress: 50 }) =>
    cambio('history', {
      messaging_product: 'whatsapp', metadata,
      history: [{ metadata: meta, threads }],
    });

  const hilo = {
    id: CLIENTE,
    messages: [
      { from: CLIENTE, to: NEGOCIO, id: 'wamid.H1', timestamp: '1754100000', type: 'text', text: { body: 'hola, tienen el Nº 5?' }, history_context: { status: 'DELIVERED' } },
      { from: NEGOCIO, to: CLIENTE, id: 'wamid.H2', timestamp: '1754100060', type: 'text', text: { body: 'si, te paso precio' }, history_context: { status: 'READ' } },
    ],
  };

  it('un chunk de historial es INERTE: no produce mensajes ni echoes', () => {
    const r = parseMetaWebhookPayload(historyPayload([hilo]));
    expect(r.messages).toHaveLength(0);
    expect(r.echoes).toHaveLength(0);
    expect(r.historyChunks).toHaveLength(1);
    const c = r.historyChunks[0]!;
    expect(c.externalId).toBe(PNID);
    expect(c.phase).toBe(0);
    expect(c.chunkOrder).toBe(1);
    expect(c.progress).toBe(50);
    expect(c.threadCount).toBe(1);
    expect(c.messageCount).toBe(2);
    expect(c.automationEligible).toBe(false);
  });

  it('la dirección se DERIVA del hilo: el número del negocio tampoco viaja en el historial', () => {
    const c = parseMetaWebhookPayload(historyPayload([hilo])).historyChunks[0]!;
    expect(c.threads[0]!.customerWaId).toBe(CLIENTE);
    expect(c.threads[0]!.messages.map((m) => m.direction)).toEqual(['in', 'out']);
    expect(JSON.stringify(c)).not.toContain(NEGOCIO);
  });

  it('chunk gigante → se marca `truncated` (nada se pierde EN SILENCIO)', () => {
    const enorme = {
      id: CLIENTE,
      messages: Array.from({ length: 5000 }, (_, i) => ({
        from: CLIENTE, to: NEGOCIO, id: `wamid.B${i}`, timestamp: '1754100000', type: 'text', text: { body: 'x' },
      })),
    };
    const c = parseMetaWebhookPayload(historyPayload([enorme])).historyChunks[0]!;
    expect(c.truncated).toBe(true);
    expect(c.messageCount).toBe(5000); // el CONTEO es honesto…
    expect(c.threads[0]!.messages.length).toBeLessThan(5000); // …aunque el doc guarde menos
  });

  it('metadata ausente o basura → chunk igual válido, con nulls (parseo defensivo)', () => {
    const c = parseMetaWebhookPayload(historyPayload([hilo], { phase: 'x' } as Record<string, unknown>)).historyChunks[0]!;
    expect(c.phase).toBeNull();
    expect(c.chunkOrder).toBeNull();
    expect(c.progress).toBeNull();
  });
});

describe('despachador por change.field — smb_app_state_sync', () => {
  const appStatePayload = (...items: unknown[]) =>
    cambio('smb_app_state_sync', { messaging_product: 'whatsapp', metadata, state_sync: items });

  it('un contacto de la agenda NO es un cliente: se normaliza marcado como tal', () => {
    const r = parseMetaWebhookPayload(appStatePayload({
      type: 'contact',
      contact: { full_name: 'Pablo  Morales', first_name: 'Pablo', phone_number: '595981111111' },
      action: 'add',
      metadata: { timestamp: '1754200500' },
    }));
    expect(r.messages).toHaveLength(0);
    expect(r.echoes).toHaveLength(0);
    expect(r.appStateChanges).toHaveLength(1);
    const c = r.appStateChanges[0]!;
    expect(c.externalId).toBe(PNID);
    expect(c.entryType).toBe('contact');
    expect(c.action).toBe('add');
    expect(c.contactWaId).toBe('595981111111');
    expect(c.fullName).toBe('Pablo Morales'); // saneado
    expect(c.timestamp).toBe(1754200500);
    expect(c.createsCustomer).toBe(false); // ADR-0017 §4: jamás fabrica clientes
  });

  it('action desconocida → `unknown` (no se asume `add`) y nombres hostiles llegan saneados', () => {
    const r = parseMetaWebhookPayload(appStatePayload({
      type: 'contact',
      contact: { full_name: `Ana${'‮'}\n\nX`.padEnd(400, 'z'), phone_number: '595982222222' },
      action: 'purge_all',
    }));
    expect(r.appStateChanges[0]!.action).toBe('unknown');
    expect(r.appStateChanges[0]!.fullName).not.toContain('‮');
    expect(r.appStateChanges[0]!.fullName.length).toBeLessThanOrEqual(128);
  });

  it('contacto sin teléfono → ignorado', () => {
    const r = parseMetaWebhookPayload(appStatePayload({ type: 'contact', contact: { full_name: 'Sin numero' }, action: 'add' }));
    expect(r.appStateChanges).toHaveLength(0);
    expect(r.ignored).toBe(1);
  });
});

describe('despachador por change.field — campo desconocido y no regresión', () => {
  it('campo desconocido → auditoría SANEADA (forma, no contenido) y cero negocio', () => {
    const r = parseMetaWebhookPayload(
      cambio('flows_beta_v9', { messaging_product: 'whatsapp', metadata, secretos: [{ token: 'EAAG-token-real', telefono: NEGOCIO }] }),
    );
    expect(r.messages).toHaveLength(0);
    expect(r.echoes).toHaveLength(0);
    expect(r.historyChunks).toHaveLength(0);
    expect(r.appStateChanges).toHaveLength(0);
    expect(r.unknownFields).toHaveLength(1);
    const u = r.unknownFields[0]!;
    expect(u.field).toBe('flows_beta_v9');
    expect(u.valueKeys).toEqual(['messaging_product', 'metadata', 'secretos']);
    // Se audita la FORMA. El contenido no se transporta ni se persiste.
    expect(JSON.stringify(u)).not.toContain('EAAG-token-real');
    expect(JSON.stringify(u)).not.toContain(NEGOCIO);
  });

  it('un `field` hostil (largo, con controles) se audita acotado', () => {
    const r = parseMetaWebhookPayload(cambio(`raro\n${'z'.repeat(500)}`, {}));
    expect(r.unknownFields[0]!.field.length).toBeLessThanOrEqual(64);
    expect(r.unknownFields[0]!.field).not.toContain('\n');
  });

  it('SIN REGRESIONES: `messages` sigue produciendo exactamente lo de antes', () => {
    const r = parseMetaWebhookPayload(load('incoming-text.json'));
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]!.from).toBe('595991234567');
    expect(r.echoes).toHaveLength(0);
    expect(r.historyChunks).toHaveLength(0);
    expect(r.unknownFields).toHaveLength(0);
    // wa-status: el recibo de entrega sigue contando como ignorado.
    expect(parseMetaWebhookPayload(load('wa-status.json')).ignored).toBe(1);
  });

  it('el ruteo es por `field`, NO por la forma del payload', () => {
    // Un cambio declarado `messages` que además trae `message_echoes` no genera echoes: si el
    // ruteo mirara la forma, cualquiera podría colar un echo dentro de un cambio de mensajes.
    const r = parseMetaWebhookPayload(cambio('messages', {
      metadata, messages: [{ from: CLIENTE, id: 'wamid.M1', timestamp: '1754200000', type: 'text', text: { body: 'hola' } }],
      message_echoes: [echoTexto()],
    }));
    expect(r.messages).toHaveLength(1);
    expect(r.echoes).toHaveLength(0);
    // …y al revés: un `smb_message_echoes` que traiga `messages` no genera inbound.
    const r2 = parseMetaWebhookPayload(cambio('smb_message_echoes', {
      metadata, message_echoes: [echoTexto()],
      messages: [{ from: NEGOCIO, id: 'wamid.M2', timestamp: '1754200000', type: 'text', text: { body: 'colado' } }],
    }));
    expect(r2.messages).toHaveLength(0);
    expect(r2.echoes).toHaveLength(1);
  });

  it('RETROCOMPATIBLE: un cambio SIN `field` se sigue tratando como `messages`', () => {
    const sinField = load('incoming-text.json');
    delete sinField.entry[0].changes[0].field;
    expect(parseMetaWebhookPayload(sinField).messages).toHaveLength(1);
  });

  it('malformado → no lanza y no inventa eventos', () => {
    for (const basura of [null, {}, 'x', cambio('history', null), cambio('smb_message_echoes', { message_echoes: 'no-array' })]) {
      const r = parseMetaWebhookPayload(basura);
      expect(r.messages).toHaveLength(0);
      expect(r.echoes).toHaveLength(0);
      expect(r.historyChunks).toHaveLength(0);
    }
  });
});
