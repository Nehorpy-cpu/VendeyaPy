import { describe, it, expect, vi } from 'vitest';

/**
 * HECHO 7 / test 9 del programa — SELECCIONAR UN NÚMERO QUE NO AUTOMATIZA APAGA EL BOT.
 * =====================================================================================
 * `selectMetaPhoneNumber` marca el número por defecto del tenant (`selected: true`), que es el que
 * resuelven las credenciales de salida cuando el outbound no sabe por qué número entró el mensaje.
 * Hoy el callable acepta CUALQUIER asset del tenant sin mirar su `automationMode`: elegir un PNID
 * que resuelve `inactive` (o `shadow`) mientras otro número está `live` deja al tenant con un
 * DEFAULT que no automatiza — el bot deja de responder aunque el panel diga «éxito».
 *
 * El guard es MÍNIMO a propósito y NO puede romper el mundo pre-migración: en producción HOY el
 * asset seleccionado no tiene `automationMode` (la migración del Paso 5 del runbook no corrió), y
 * ahí la selección tiene que seguir funcionando igual. Por eso el rechazo exige DOS cosas a la vez:
 *
 *   1. el asset destino RESUELVE un modo que no automatiza (`inactive` por declaración, por basura
 *      o por ausencia bajo fail-closed; `shadow` también, porque `shadow` no responde a nadie), Y
 *   2. existe OTRO asset del tenant que DECLARA `live` — o sea, hay una automatización encendida
 *      que esta selección apagaría.
 *
 * Sin (2) no hay nada que perder: el tenant pre-migración (nadie declara nada) pasa entero. El
 * cutover automático desde la UI queda PROHIBIDO: la transición completa es de la herramienta
 * release-only (`cutover-whatsapp-number.mjs`), no de este callable.
 *
 * Mismo molde que `metaConnect.modo.test.ts`: se prueba la función PURA exportada; el callable es
 * la cáscara que la aplica antes de escribir. La autorización del callable NO cambia.
 */
vi.mock('../../lib/firebase.js', () => ({ db: () => ({}), paths: {} }));

import { rechazoDeSeleccionPorAutomatizacion } from './metaConnect.js';

const PNID_LIVE = '111000111';
const PNID_NUEVO = '222000222';
const PNID_TERCERO = '333000333';

/** El tenant del RIESGO REAL: un número vendiendo (`live`) y el de Coexistence recién nacido. */
const numeroLive = (extra: Record<string, unknown> = {}) => ({
  externalId: PNID_LIVE, assetType: 'whatsapp_phone_number', status: 'active', selected: true,
  connectionId: 'main', automationMode: 'live', ...extra,
});
const numeroNuevo = (extra: Record<string, unknown> = {}) => ({
  externalId: PNID_NUEVO, assetType: 'whatsapp_phone_number', status: 'active', selected: false,
  connectionId: `wa_${PNID_NUEVO}`, sessionKey: `wa_${PNID_NUEVO}`, ...extra,
});

describe('rechazoDeSeleccionPorAutomatizacion — el default del tenant no puede dejar de automatizar', () => {
  it('DEFECTO (test 9): elegir un PNID `inactive` con otro número `live` se RECHAZA', () => {
    const nuevo = numeroNuevo({ automationMode: 'inactive' });
    const motivo = rechazoDeSeleccionPorAutomatizacion(nuevo, [numeroLive(), nuevo]);
    expect(motivo).not.toBeNull();
  });

  it('un PNID SIN el campo también se rechaza si hay un `live` vivo: fail-closed lo lee `inactive`', () => {
    const nuevo = numeroNuevo(); // así nace un número de Coexistence: sin `automationMode`
    expect(rechazoDeSeleccionPorAutomatizacion(nuevo, [numeroLive(), nuevo])).not.toBeNull();
  });

  it('`shadow` tampoco puede quedar de default mientras otro está `live`: shadow no responde a nadie', () => {
    const nuevo = numeroNuevo({ automationMode: 'shadow' });
    expect(rechazoDeSeleccionPorAutomatizacion(nuevo, [numeroLive(), nuevo])).not.toBeNull();
  });

  it('la basura (`LIVE`) no es un permiso: el gate la lee `inactive`, así que se rechaza igual', () => {
    const nuevo = numeroNuevo({ automationMode: 'LIVE' });
    expect(rechazoDeSeleccionPorAutomatizacion(nuevo, [numeroLive(), nuevo])).not.toBeNull();
  });

  it('elegir el número que YA está `live` siempre pasa (es el caso legítimo de hoy)', () => {
    const live = numeroLive();
    expect(rechazoDeSeleccionPorAutomatizacion(live, [live, numeroNuevo()])).toBeNull();
  });
});

describe('rechazoDeSeleccionPorAutomatizacion — compatibilidad hacia atrás (producción HOY)', () => {
  it('el mundo pre-migración pasa entero: NADIE declara `automationMode` y la selección funciona', () => {
    // Producción hoy: el asset seleccionado no tiene el campo (Paso 5 del runbook aún no corrió).
    const a = numeroLive({ automationMode: undefined });
    delete (a as Record<string, unknown>)['automationMode'];
    const b = numeroNuevo();
    expect(rechazoDeSeleccionPorAutomatizacion(a, [a, b])).toBeNull();
    expect(rechazoDeSeleccionPorAutomatizacion(b, [a, b])).toBeNull();
  });

  it('sin ningún `live` declarado no hay nada que apagar: `shadow`/`inactive` se pueden elegir', () => {
    const a = numeroNuevo({ externalId: PNID_LIVE, automationMode: 'shadow' });
    const b = numeroNuevo({ automationMode: 'inactive' });
    expect(rechazoDeSeleccionPorAutomatizacion(b, [a, b])).toBeNull();
  });

  it('el destino no se compara consigo mismo: un único número `live` se re-elige sin drama', () => {
    const unico = numeroLive();
    expect(rechazoDeSeleccionPorAutomatizacion(unico, [unico])).toBeNull();
  });

  it('un destino inexistente no opina: ese caso lo responde el `not-found` del callable', () => {
    expect(rechazoDeSeleccionPorAutomatizacion(null, [numeroLive()])).toBeNull();
    expect(rechazoDeSeleccionPorAutomatizacion(undefined, [numeroLive()])).toBeNull();
  });

  it('un tercero `live` distinto del destino y del actual también cuenta como automatización viva', () => {
    const tercero = numeroLive({ externalId: PNID_TERCERO, selected: false });
    const nuevo = numeroNuevo();
    expect(rechazoDeSeleccionPorAutomatizacion(nuevo, [tercero, nuevo])).not.toBeNull();
  });
});

describe('el motivo del rechazo es SANEADO', () => {
  it('no filtra nada operativo: ni tokens, ni rutas de documentos, ni PNIDs', () => {
    const nuevo = numeroNuevo({ automationMode: 'inactive' });
    const motivo = rechazoDeSeleccionPorAutomatizacion(nuevo, [numeroLive(), nuevo]) ?? '';
    expect(motivo).not.toMatch(/token|secret|metaAssets|metaExternalIndex|metaConnections/i);
    expect(motivo).not.toContain(PNID_NUEVO);
    expect(motivo).not.toContain(PNID_LIVE);
  });
});

describe('el modo efectivo del destino incluye al ÍNDICE (correctivo, MEDIO 16)', () => {
  it('asset `live` + índice `inactive` (degradado a medias) ⇒ rechaza igual que el gate del webhook', () => {
    const destino = { externalId: '111', automationMode: 'live', indiceAutomationMode: 'inactive' };
    const otro = { externalId: '222', automationMode: 'live' };

    // El inbound de ese número va a resolver `inactive` (más restrictivo): elegirlo de default
    // apagaría las respuestas de la empresa aunque el asset jure `live`.
    expect(rechazoDeSeleccionPorAutomatizacion(destino, [destino, otro])).not.toBeNull();
  });

  it('asset e índice ambos `live` ⇒ pasa (el índice que coincide no molesta)', () => {
    const destino = { externalId: '111', automationMode: 'live', indiceAutomationMode: 'live' };
    expect(rechazoDeSeleccionPorAutomatizacion(destino, [destino])).toBeNull();
  });

  it('índice sin opinión (ausente) conserva el comportamiento previo', () => {
    const destino = { externalId: '111', automationMode: 'live' };
    expect(rechazoDeSeleccionPorAutomatizacion(destino, [destino])).toBeNull();
  });
});
