/**
 * meta/catalogOwnership.ts — Propiedad por campos del catálogo (ADR-0015)
 * =======================================================================
 * PURO. Define QUÉ campo público gobierna cada sistema y normaliza la declaración de
 * propiedad con FAIL-CLOSED DE NIVEL 2: config de sync válida pero `ownership` ausente,
 * legacy, inválida o contradictoria ⇒ cero campos escribibles y modo efectivo `dry_run`.
 * (El nivel 1 —config de sync inválida ⇒ sync apagada del todo— vive en catalogSyncConfig.ts
 * y queda INTACTO: un tenant sin config, como credipower, jamás toca Meta.)
 *
 * Por qué existe: `sourceOfTruth` era un literal decorativo cuyo único valor legal
 * (`'vendeyapy'`) era FALSO para arfagi — el catálogo lo gobierna un feed diario del sitio del
 * tenant (auditoría del 2026-07-30). Un campo con dos escritores es un loop; un campo sin
 * dueño declarado no se escribe.
 */

/**
 * Campos PÚBLICOS del contrato de escritura (ADR-0012) que pueden tener dueño. Deliberadamente
 * NO incluye costo, márgenes, `productFinancials`, `aiFicha` ni notas internas: esos son
 * exclusivamente locales y jamás publicables ni delegables (ADR-0015 §1).
 */
export const WRITABLE_FIELDS = [
  'title',
  'description',
  'price',
  'currency',
  'availability',
  'inventory',
  'brand',
  'category',
  'image',
  'url',
] as const;
export type WritableField = (typeof WRITABLE_FIELDS)[number];

const WRITABLE_SET = new Set<string>(WRITABLE_FIELDS);

/** Campos que JAMÁS pueden declararse como propiedad de nadie (ni nuestra ni externa). */
export const NEVER_PUBLISHABLE = ['cost', 'costPrice', 'margin', 'productFinancials', 'aiFicha', 'aiNotes', 'priorityScore'] as const;

export const CATALOG_OWNERSHIP_MODELS = ['vendeyapy_managed', 'external_managed', 'hybrid'] as const;
export type CatalogOwnershipModel = (typeof CATALOG_OWNERSHIP_MODELS)[number];

export const EXTERNAL_SOURCE_KINDS = ['meta_feed', 'commerce_manager', 'other_api'] as const;
export type ExternalSourceKind = (typeof EXTERNAL_SOURCE_KINDS)[number];

/**
 * Fuente externa RECONOCIDA por una persona. `fingerprint` es una huella SANEADA (identificador,
 * host sin query, horario, columnas) — nunca la URL firmada, su query string ni el token.
 */
export interface ExternalSourceDeclaration {
  kind: ExternalSourceKind;
  /** Ids de feed/data source reconocidos explícitamente. Vacío ⇒ inválido para `meta_feed`. */
  acknowledgedSourceIds: string[];
  /** Campos públicos que esa fuente publica (los gobierna ella). */
  declaredFields: WritableField[];
  /** Huella saneada observada al reconocer. Si cambia ⇒ hay que volver a reconocer. */
  fingerprint: string;
  acknowledgedAt: unknown;
  acknowledgedByUid: string;
}

export interface CatalogOwnership {
  model: CatalogOwnershipModel;
  /** Campos que VendeYaPy escribe. Canónico: ordenado, deduplicado, ⊆ WRITABLE_FIELDS. */
  ownedFields: WritableField[];
  external: ExternalSourceDeclaration | null;
  /** Última verificación de fuentes externas contra la API oficial. */
  lastSourceCheckAt: unknown;
}

/** Motivos por los que la propiedad quedó degradada. Se muestran al owner y se auditan. */
export type OwnershipDegradedReason =
  | 'ownership_missing' // documento legacy (solo sourceOfTruth) o campo ausente
  | 'ownership_malformed' // no es objeto / model desconocido / listas inválidas
  | 'ownership_conflict' // un campo declarado por VendeYaPy Y por la fuente externa
  | 'ownership_never_publishable' // se intentó declarar un campo interno (costo, aiFicha…)
  | 'external_declaration_invalid' // `external` presente pero incompleto/sin ids reconocidos
  | 'external_required' // el modelo exige fuente externa reconocida y no hay
  | 'owned_fields_required' // el modelo exige campos propios y la lista está vacía
  | 'hybrid_partition_missing'; // hybrid sin matriz explícita de ambos lados

/**
 * Resultado de normalizar la propiedad. `writable` es la ÚNICA lista que los gates deben
 * consultar: en cualquier duda queda vacía y `modeCeiling` fuerza `dry_run`.
 */
export interface EffectiveOwnership {
  model: CatalogOwnershipModel;
  /** Campos que VendeYaPy PUEDE escribir hoy. Vacía ⇒ no existe patch posible. */
  writable: WritableField[];
  /**
   * Campos gobernados por la fuente externa reconocida. Con `hybrid` son los declarados; con
   * `external_managed` son TODOS los públicos (el modelo ya dice que el gobierno es de afuera,
   * y `ownedFields` está vacío por definición). Vacía ⇒ el guard de deriva queda inerte.
   */
  external: WritableField[];
  externalSource: ExternalSourceDeclaration | null;
  /** Techo de ejecución: 'dry_run' impide escribir aunque la config diga `live`. */
  modeCeiling: 'dry_run' | 'live';
  degraded: boolean;
  reasons: OwnershipDegradedReason[];
}

/**
 * Degradación fail-closed de nivel 2: se puede leer y diagnosticar, no escribir. El modelo
 * reportado es `external_managed` porque es el supuesto SEGURO: si no sabemos quién manda,
 * asumimos que no somos nosotros.
 */
export const OWNERSHIP_DEGRADED: EffectiveOwnership = Object.freeze({
  model: 'external_managed',
  writable: Object.freeze([]) as unknown as WritableField[],
  external: Object.freeze([]) as unknown as WritableField[],
  externalSource: null,
  modeCeiling: 'dry_run',
  degraded: true,
  reasons: Object.freeze(['ownership_missing']) as unknown as OwnershipDegradedReason[],
});

const degradado = (...reasons: OwnershipDegradedReason[]): EffectiveOwnership => ({
  ...OWNERSHIP_DEGRADED,
  writable: [],
  external: [],
  reasons: [...reasons],
});

/** Lista de campos públicos canónica: solo válidos, sin repetidos, orden estable. */
function camposCanonicos(raw: unknown): { fields: WritableField[]; invalido: boolean; interno: boolean } {
  if (!Array.isArray(raw)) return { fields: [], invalido: raw !== undefined, interno: false };
  const out = new Set<WritableField>();
  let invalido = false;
  let interno = false;
  for (const x of raw) {
    if (typeof x !== 'string') { invalido = true; continue; }
    const v = x.trim();
    if ((NEVER_PUBLISHABLE as readonly string[]).includes(v)) { interno = true; continue; }
    if (!WRITABLE_SET.has(v)) { invalido = true; continue; }
    out.add(v as WritableField);
  }
  return { fields: WRITABLE_FIELDS.filter((f) => out.has(f)), invalido, interno };
}

function normalizarExterna(raw: unknown): { source: ExternalSourceDeclaration | null; motivo: OwnershipDegradedReason | null } {
  if (raw === null || raw === undefined) return { source: null, motivo: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { source: null, motivo: 'external_declaration_invalid' };
  const r = raw as Record<string, unknown>;
  const kind = typeof r.kind === 'string' ? r.kind : '';
  if (!(EXTERNAL_SOURCE_KINDS as readonly string[]).includes(kind)) return { source: null, motivo: 'external_declaration_invalid' };
  const ids = Array.isArray(r.acknowledgedSourceIds)
    ? r.acknowledgedSourceIds.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim())
    : [];
  // Un feed reconocido SIN ids no es un reconocimiento: es una promesa vacía.
  if (kind === 'meta_feed' && !ids.length) return { source: null, motivo: 'external_declaration_invalid' };
  const decl = camposCanonicos(r.declaredFields);
  if (decl.invalido || decl.interno) return { source: null, motivo: decl.interno ? 'ownership_never_publishable' : 'external_declaration_invalid' };
  const fingerprint = typeof r.fingerprint === 'string' ? r.fingerprint.trim() : '';
  const uid = typeof r.acknowledgedByUid === 'string' ? r.acknowledgedByUid.trim() : '';
  // Sin huella o sin quién reconoció no hay trazabilidad del permiso.
  if (!fingerprint || !uid) return { source: null, motivo: 'external_declaration_invalid' };
  return {
    source: {
      kind: kind as ExternalSourceKind,
      acknowledgedSourceIds: [...new Set(ids)].sort(),
      declaredFields: decl.fields,
      fingerprint,
      acknowledgedAt: r.acknowledgedAt ?? null,
      acknowledgedByUid: uid,
    },
    motivo: null,
  };
}

/**
 * Normaliza `catalogSync.ownership`. FAIL-CLOSED: cualquier ausencia, forma inválida,
 * contradicción o campo interno declarado ⇒ `writable: []` + `modeCeiling: 'dry_run'`.
 * NO interpreta el documento legacy (solo `sourceOfTruth`) como permiso de escritura: cae en
 * `ownership_missing` y se migra explícitamente (ADR-0015 §9).
 */
export function normalizeCatalogOwnership(raw: unknown): EffectiveOwnership {
  if (raw === undefined || raw === null) return degradado('ownership_missing');
  if (typeof raw !== 'object' || Array.isArray(raw)) return degradado('ownership_malformed');
  const r = raw as Record<string, unknown>;
  const model = typeof r.model === 'string' ? r.model : '';
  if (!(CATALOG_OWNERSHIP_MODELS as readonly string[]).includes(model)) return degradado('ownership_malformed');

  const propios = camposCanonicos(r.ownedFields);
  if (propios.interno) return degradado('ownership_never_publishable');
  if (propios.invalido) return degradado('ownership_malformed');

  const ext = normalizarExterna(r.external);
  if (ext.motivo) return degradado(ext.motivo);

  const externos = ext.source?.declaredFields ?? [];
  // INVARIANTE DURA: un campo, un dueño. Dos escritores del mismo campo son un loop diario.
  const choque = propios.fields.filter((f) => externos.includes(f));
  if (choque.length) return degradado('ownership_conflict');

  const base = {
    model: model as CatalogOwnershipModel,
    external: externos,
    externalSource: ext.source,
    lastSourceCheckAt: r.lastSourceCheckAt ?? null,
  };

  if (model === 'external_managed') {
    // La fuente externa gobierna: NO exigimos que declare campos (puede publicar todo), pero
    // VendeYaPy no escribe nada. `ownedFields` con contenido es una contradicción del modelo.
    if (propios.fields.length) return degradado('ownership_conflict');
    // …y SÍ exigimos que haya una fuente reconocida: "manda alguien de afuera" sin decir quién
    // es una declaración vacía. Sin ids ni huella no hay nada contra qué comparar en el chequeo
    // previo al POST (§4) y la alerta administrativa del nivel 2 nunca se dispararía — el panel
    // mostraría verde sobre una propiedad que nadie reconoció.
    if (!ext.source) return degradado('external_required');
    // CAMPOS EXTERNOS EFECTIVOS = TODOS los públicos menos los propios (que acá son CERO).
    // `declaredFields` describe lo que la fuente dijo publicar, pero el MODELO ya declaró que
    // el gobierno de los campos públicos es de afuera: si la lista quedara corta (o vacía, que
    // es el caso normal porque el cliente no pide columnas a Graph), el guard de deriva se
    // quedaría inerte —la lista de campos externos viaja vacía y la clasificación corta— y un
    // precio divergente se reportaría como "sin deriva". Un campo público sin dueño nuestro,
    // bajo este modelo, es de la fuente externa: eso es lo que ya asume `fieldOwner`.
    return { ...base, external: [...WRITABLE_FIELDS], writable: [], modeCeiling: 'dry_run', degraded: false, reasons: [] };
  }

  if (model === 'vendeyapy_managed') {
    if (!propios.fields.length) return degradado('owned_fields_required');
    // La MERA PRESENCIA de una fuente externa reconocida contradice el modelo, publique o no
    // campos. Antes se miraba solo `externos.length`, y como el detector casi nunca informa
    // columnas (Graph no las devuelve si no se piden), `declaredFields: []` era el caso NORMAL:
    // una fuente reconocida con lista vacía dejaba `writable` COMPLETO y techo `live`, es decir
    // el loop diario justo en el modelo que el ADR declara imposible. Si la fuente publica
    // campos, el modelo correcto es `hybrid`; si no publica ninguno, no debería estar declarada.
    if (ext.source) return degradado('ownership_conflict');
    return { ...base, writable: propios.fields, modeCeiling: 'live', degraded: false, reasons: [] };
  }

  // hybrid: exige matriz EXPLÍCITA de los dos lados; la propiedad jamás se infiere.
  if (!propios.fields.length) return degradado('owned_fields_required');
  if (!ext.source || !externos.length) return degradado('hybrid_partition_missing');
  return { ...base, writable: propios.fields, modeCeiling: 'live', degraded: false, reasons: [] };
}

/** ¿VendeYaPy gobierna este campo público hoy? Única pregunta que deben hacer los gates. */
export function ownsField(own: EffectiveOwnership, field: WritableField): boolean {
  return own.writable.includes(field);
}

/** Campos de un patch que NO son nuestros (vacío ⇒ el patch es legítimo). */
export function fieldsNotOwned(own: EffectiveOwnership, fields: readonly string[]): string[] {
  return fields.filter((f) => !(WRITABLE_SET.has(f) && own.writable.includes(f as WritableField)));
}

/** Modo EFECTIVO: el techo de la propiedad nunca puede ser superado por la config de ejecución. */
export function effectiveMode(configMode: 'off' | 'dry_run' | 'live', own: EffectiveOwnership): 'off' | 'dry_run' | 'live' {
  if (configMode === 'off') return 'off';
  if (configMode === 'live' && own.modeCeiling === 'live') return 'live';
  return 'dry_run';
}
