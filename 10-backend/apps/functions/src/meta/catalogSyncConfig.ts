/**
 * meta/catalogSyncConfig.ts — Config por tenant de la sync de catálogo (META-CATALOG-LIVE-1)
 * ==========================================================================================
 * Vive en `tenants/{t}/config/meta` campo `catalogSync`. FAIL-CLOSED: cualquier forma
 * inválida, ausente o parcial se normaliza a { enabled:false, mode:'off' } — un tenant sin
 * config explícita (p.ej. credipower) JAMÁS sincroniza.
 *
 * Acá conviven DOS preguntas que el ADR-0015 separó y que no hay que volver a mezclar:
 *  · EJECUCIÓN — «¿mandamos NOSOTROS algo a Meta?»: `normalizeCatalogSyncConfig`, el gate de
 *    nivel 1. `sourceOfTruth` quedó como literal legacy y ya no gobierna nada.
 *  · PROPIEDAD — «¿manda alguien de AFUERA sobre los campos públicos?»: `declaredExternalFields`,
 *    que NO pasa por el interruptor. Apagar nuestra sincronización no apaga el feed del tenant.
 *  · CAPACIDAD DE MIRAR — «¿hay un catálogo remoto que LEER?»: `declaredCatalogId`, también sin
 *    interruptor. Verificar es un GET: dejar de escribir no puede dejarnos ciegos, porque la
 *    evidencia que refresca el estado es lo único que impide que todo caduque a `stale`.
 */

import {
  normalizeCatalogOwnership,
  OWNERSHIP_DEGRADED,
  type EffectiveOwnership,
  type ExternalSourceDeclaration,
  type WritableField,
} from './catalogOwnership.js';

export const CATALOG_SYNC_MODES = ['off', 'dry_run', 'live'] as const;
export type CatalogSyncMode = (typeof CATALOG_SYNC_MODES)[number];

export interface MetaCatalogSyncConfig {
  enabled: boolean;
  mode: CatalogSyncMode;
  /** ID del catálogo en Meta Commerce Manager. Sin valor válido ⇒ sync apagada. */
  catalogId: string;
  /**
   * LEGACY (ADR-0015): literal decorativo del contrato viejo. Se conserva SOLO para leer
   * documentos previos a la migración; ya NO gobierna nada y jamás se interpreta como permiso
   * de escritura. La autoridad real vive en `ownership` (meta/catalogOwnership.ts).
   */
  sourceOfTruth: 'vendeyapy';
  /** Propiedad por campos NORMALIZADA (fail-closed de nivel 2). Nunca es null: degrada. */
  ownership: EffectiveOwnership;
}

export const CATALOG_SYNC_DISABLED: MetaCatalogSyncConfig = Object.freeze({
  enabled: false,
  mode: 'off',
  catalogId: '',
  sourceOfTruth: 'vendeyapy',
  ownership: OWNERSHIP_DEGRADED,
});

// El catalogId viaja en la URL del Graph API: solo caracteres seguros, sin '/' ni espacios.
const VALID_CATALOG_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * `catalogId` VÁLIDO declarado en la config, leído SIN pasar por el interruptor de sync (mismo
 * eje que `declaredExternalFields`). Es la respuesta a «¿hay un catálogo remoto que MIRAR?»,
 * que no es la misma pregunta que «¿tenemos permiso de ESCRIBIR?».
 *
 * Por qué hace falta: `normalizeCatalogSyncConfig` devuelve la config apagada ENTERA —con
 * `catalogId: ''`— ante `enabled:false` o `mode:'off'`. Para escribir está perfecto; para la
 * reconciliación (que solo hace GET) borraba el único dato que le permite volver a mirar Meta.
 *
 * Devuelve SOLO el id a propósito: de acá no sale ni un permiso ni un modo.
 */
export function declaredCatalogId(rawCatalogSync: unknown): string {
  if (typeof rawCatalogSync !== 'object' || rawCatalogSync === null || Array.isArray(rawCatalogSync)) return '';
  const raw = (rawCatalogSync as Record<string, unknown>).catalogId;
  const id = typeof raw === 'string' ? raw.trim() : '';
  return VALID_CATALOG_ID.test(id) ? id : '';
}

/** Normaliza el campo `catalogSync` del doc de config. Cualquier duda ⇒ apagado. */
export function normalizeCatalogSyncConfig(raw: unknown): MetaCatalogSyncConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return CATALOG_SYNC_DISABLED;
  const r = raw as Record<string, unknown>;
  if (r.enabled !== true) return CATALOG_SYNC_DISABLED;
  if (r.mode !== 'dry_run' && r.mode !== 'live') return CATALOG_SYNC_DISABLED;
  // MISMA derivación que usa la reconciliación: si acá se validara distinto, un id que el gate
  // de escritura acepta podría ser el que el barrido rechaza (o al revés).
  const catalogId = declaredCatalogId(raw);
  if (!catalogId) return CATALOG_SYNC_DISABLED;
  // NIVEL 2 (ADR-0015): la propiedad se normaliza aparte y degrada sola. `sourceOfTruth` ya no
  // decide nada: un documento legacy queda con ownership degradada (cero campos escribibles y
  // techo dry_run), que es exactamente lo que corresponde hasta que un humano declare la
  // propiedad. Se conserva el literal en el tipo solo para leer documentos previos.
  return { enabled: true, mode: r.mode, catalogId, sourceOfTruth: 'vendeyapy', ownership: normalizeCatalogOwnership(r.ownership) };
}

/**
 * Campos públicos que una fuente externa RECONOCIDA gobierna hoy en este tenant, leídos de
 * forma INDEPENDIENTE del interruptor de sincronización.
 *
 * Por qué NO alcanza con `normalizeCatalogSyncConfig(...).ownership.external`: esa función es el
 * gate de NUESTRA escritura (nivel 1) y ante `enabled:false`, `mode:'off'` o `catalogId`
 * inválido devuelve la config apagada entera, con la propiedad DEGRADADA (`external: []`). Eso
 * está bien para escribir y estaba MAL para leer: apagar nuestra sync apagaba también la
 * honestidad — el bot volvía a cotizar como confirmado un precio que el feed del tenant publica
 * distinto, sin una sola alerta. Son dos preguntas distintas:
 *   · «¿mandamos NOSOTROS algo a Meta?» → la decide el interruptor (y sigue igual de cerrada);
 *   · «¿manda alguien de AFUERA sobre estos campos?» → la decide la declaración humana, y no
 *     desaparece porque nosotros dejemos de escribir. El feed diario sigue publicando.
 *
 * Sigue siendo FAIL-CLOSED en el sentido que corresponde a esta pregunta: sin `catalogSync`,
 * con una forma inválida o con `ownership` ausente/legacy/contradictoria devuelve `[]` — nadie
 * declaró gobierno externo ⇒ el guard de deriva queda INERTE y un tenant sin config (credipower)
 * no cambia en nada.
 *
 * Devuelve SOLO los campos externos a propósito: no expone `writable` ni el modo, así que no
 * puede usarse por error para autorizar una escritura con la sincronización apagada.
 */
export function declaredExternalFields(rawCatalogSync: unknown): WritableField[] {
  return declaredExternalGovernance(rawCatalogSync).fields;
}

/** Gobierno externo DECLARADO: qué campos publica esa fuente y QUIÉN es (declaración humana). */
export interface DeclaredExternalGovernance {
  fields: WritableField[];
  /** Declaración reconocida por una persona. null ⇒ nadie declaró gobierno externo. */
  source: ExternalSourceDeclaration | null;
}

/**
 * Misma pregunta —y mismo camino sin gate— que `declaredExternalFields`, pero devolviendo TAMBIÉN
 * la declaración humana. La necesita quien tiene que decir QUIÉN gobierna, no solo QUÉ campos: el
 * guard de deriva se conforma con la lista, pero la tarjeta del panel sin la fuente no puede
 * distinguir "el feed del sitio publica el catálogo" de "todavía nadie declaró nada", que es
 * exactamente la mentira que este eje existe para evitar.
 *
 * Sigue sin exponer `writable` ni el modo a propósito: de acá no sale permiso de escritura.
 */
export function declaredExternalGovernance(rawCatalogSync: unknown): DeclaredExternalGovernance {
  if (typeof rawCatalogSync !== 'object' || rawCatalogSync === null || Array.isArray(rawCatalogSync)) {
    return { fields: [], source: null };
  }
  const own = normalizeCatalogOwnership((rawCatalogSync as Record<string, unknown>).ownership);
  return { fields: [...own.external], source: own.externalSource };
}
