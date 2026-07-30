/**
 * meta/catalogOwnershipGates.ts — Puente entre el contrato de ESCRITURA y la PROPIEDAD
 * ====================================================================================
 * PURO (ADR-0015 §7). La propiedad habla de campos públicos con los nombres del CATÁLOGO
 * (`url`, `inventory`, `category`); el contrato de escritura de Meta (ADR-0012) habla de
 * `link`, `image`, `condition`. Son DOS VOCABULARIOS sobre la misma realidad, y mezclarlos
 * deja agujeros silenciosos en las dos direcciones: preguntar `ownsField(own, 'link')`
 * devuelve siempre false —`link` no existe en la lista de propiedad—, así que un patch de URL
 * quedaría bloqueado incluso siendo nuestro; y al revés, un nombre desconocido podría colarse
 * como "no aplica". Acá vive la traducción, en UN solo lugar y con el mapa completo exigido
 * por el tipo.
 *
 * Acá vive también la HUELLA de la propiedad: la foto saneada que cada job del outbox congela
 * al encolarse y que se recalcula justo antes del POST. Si cambió, ese envío perdió su permiso
 * y no sale — jamás se reintenta con permisos viejos.
 */

import { createHash } from 'node:crypto';
import { fieldsNotOwned, type EffectiveOwnership, type WritableField as OwnedField } from './catalogOwnership.js';
import { WRITABLE_FIELDS as OUTBOUND_WRITABLE_FIELDS, type WritableField as OutboundField } from './catalogOutbound.js';

/**
 * Dueño declarable de cada campo del contrato de ESCRITURA. El tipo `Record<OutboundField,…>`
 * obliga a que estén TODOS: si mañana el contrato suma un campo, esto no compila hasta que
 * alguien decida quién lo gobierna (en vez de dejarlo pasar sin propiedad declarada).
 *
 * `null` = constante ESTRUCTURAL del contrato, no un dato del negocio: `condition` viaja
 * siempre con el literal `'new'` y no representa información que una fuente externa pueda
 * gobernar ni que el vendedor edite. No tiene dueño porque no hay nada que disputar.
 */
const PROPIEDAD_DE: Readonly<Record<OutboundField, OwnedField | null>> = {
  title: 'title',
  description: 'description',
  price: 'price',
  availability: 'availability',
  brand: 'brand',
  image: 'image',
  // El contrato de escritura lo llama `link`; el catálogo —y por lo tanto la propiedad— `url`.
  link: 'url',
  condition: null,
};

const esCampoDeEscritura = (f: string): f is OutboundField => (OUTBOUND_WRITABLE_FIELDS as readonly string[]).includes(f);

/**
 * Campos AJENOS de una lista expresada en el vocabulario del contrato de ESCRITURA: los que
 * VendeYaPy no gobierna hoy, MÁS los que ni siquiera pertenecen al contrato público (un nombre
 * desconocido nunca es "nuestro por defecto"). Vacío ⇒ la lista se puede emitir entera.
 */
export function outboundFieldsNotOwned(own: EffectiveOwnership, fields: readonly string[]): string[] {
  const ajenos: string[] = [];
  for (const f of fields) {
    if (!esCampoDeEscritura(f)) { ajenos.push(f); continue; }
    const campo = PROPIEDAD_DE[f];
    if (campo === null) continue; // constante estructural: no hay dueño que declarar
    // `fieldsNotOwned` es la ÚNICA autoridad sobre la propiedad (catalogOwnership.ts): acá
    // solo se traduce el nombre, jamás se re-decide quién manda.
    if (fieldsNotOwned(own, [campo]).length) ajenos.push(f);
  }
  return [...new Set(ajenos)];
}

/** Campos ajenos de un patch YA serializado. `id` es identidad, no contenido publicable. */
export function patchFieldsNotOwned(own: EffectiveOwnership, patch: Record<string, unknown>): string[] {
  return outboundFieldsNotOwned(own, Object.keys(patch).filter((k) => k !== 'id'));
}

export class CatalogOwnershipViolation extends Error {
  constructor(readonly fields: string[], where: string) {
    super(`${where}: el patch incluye campos que VendeYaPy no gobierna (${fields.join(', ')}).`);
    this.name = 'CatalogOwnershipViolation';
  }
}

/**
 * Última barrera antes de persistir un job o de armar un lote: un patch con un solo campo
 * ajeno simplemente NO EXISTE. Se valida sobre las claves REALES del request —no sobre una
 * lista paralela que podría desincronizarse del serializador—.
 */
export function assertPatchOwned(own: EffectiveOwnership, patch: Record<string, unknown>, where = 'patch'): void {
  const ajenos = patchFieldsNotOwned(own, patch);
  if (ajenos.length) throw new CatalogOwnershipViolation(ajenos, where);
}

/**
 * Huella SANEADA de la propiedad efectiva. Cada componente viaja con su largo adelante (misma
 * defensa anti-colisión que `outboxIntentKey`): así `('a|b','c')` y `('a','b|c')` jamás dan la
 * misma huella y "cambió la propiedad" nunca puede pasar desapercibido.
 *
 * NO contiene secretos: `externalSource.fingerprint` ya es una huella saneada por contrato
 * (ADR-0015 §4 — jamás URL firmada, query string ni token) y acá además se hashea todo junto.
 */
export function ownershipFingerprint(own: EffectiveOwnership): string {
  const partes = [
    'v1',
    own.model,
    own.writable.join(','),
    own.external.join(','),
    own.modeCeiling,
    own.degraded ? '1' : '0',
    own.externalSource?.kind ?? '',
    [...(own.externalSource?.acknowledgedSourceIds ?? [])].join(','),
    own.externalSource?.fingerprint ?? '',
  ];
  return `own_${createHash('sha256').update(partes.map((p) => `${p.length}:${p}`).join('')).digest('hex').slice(0, 32)}`;
}
