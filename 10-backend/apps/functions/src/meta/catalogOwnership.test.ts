import { describe, it, expect } from 'vitest';
import {
  CATALOG_OWNERSHIP_MODELS as SHARED_MODELS,
  CATALOG_EXTERNAL_SOURCE_KINDS as SHARED_KINDS,
  CATALOG_WRITABLE_FIELDS as SHARED_FIELDS,
  type CatalogOwnershipDegradedReason as SharedReason,
  type CatalogOwnershipModel as SharedModel,
  type CatalogExternalSourceKind as SharedKind,
  type WritableField as SharedWritableField,
} from '@vpw/shared';
import {
  CATALOG_OWNERSHIP_MODELS,
  EXTERNAL_SOURCE_KINDS,
  NEVER_PUBLISHABLE,
  OWNERSHIP_DEGRADED,
  WRITABLE_FIELDS,
  effectiveMode,
  fieldsNotOwned,
  normalizeCatalogOwnership,
  ownsField,
  type CatalogOwnershipModel,
  type EffectiveOwnership,
  type ExternalSourceKind,
  type OwnershipDegradedReason,
  type WritableField,
} from './catalogOwnership.js';

/**
 * META-CATALOG-OWNERSHIP-MODEL-1 (ADR-0015) — FAIL-CLOSED DE NIVEL 2.
 *
 * El normalizador es el único lugar donde se decide QUIÉN escribe cada campo público. La
 * auditoría del 2026-07-30 mostró el costo de equivocarse: `sourceOfTruth:'vendeyapy'` era un
 * literal decorativo mientras un feed diario del sitio del tenant gobernaba los 181 artículos,
 * y con `mode:'live'` eso habría sido un loop de escritura diario. La regla que estos tests
 * blindan es una sola: ante CUALQUIER duda —ausencia, forma inválida, contradicción, campo
 * interno o fuente sin reconocer— la respuesta es CERO campos escribibles y techo `dry_run`.
 * Nunca "asumí que mandamos nosotros".
 */

/** Fuente externa VÁLIDA mínima (huella y uid saneados: jamás URL firmada ni token). */
const feedValido = (over: Record<string, unknown> = {}) => ({
  kind: 'meta_feed',
  acknowledgedSourceIds: ['ds-1'],
  declaredFields: ['price', 'availability'],
  fingerprint: 'meta_feed:ds-1|tienda.test|03:33|price,availability',
  acknowledgedAt: { seconds: 1, nanoseconds: 0 },
  acknowledgedByUid: 'uid-owner',
  ...over,
});

/** Aserción de degradación: cero escrituras, techo dry_run y el motivo EXACTO esperado. */
const esperarDegradada = (r: EffectiveOwnership, ...reasons: OwnershipDegradedReason[]): void => {
  expect(r.degraded).toBe(true);
  expect(r.reasons).toEqual(reasons);
  expect(r.writable).toEqual([]);
  expect(r.external).toEqual([]);
  expect(r.externalSource).toBeNull();
  expect(r.modeCeiling).toBe('dry_run');
  // El modelo reportado es el supuesto SEGURO: si no sabemos quién manda, no somos nosotros.
  expect(r.model).toBe('external_managed');
};

// ---------------------------------------------------------------------------
// Vocabulario: invariantes del contrato + paridad con @vpw/shared
// ---------------------------------------------------------------------------

describe('vocabulario del contrato de propiedad', () => {
  it('ningún campo interno es publicable (intersección vacía con WRITABLE_FIELDS)', () => {
    const cruce = (NEVER_PUBLISHABLE as readonly string[]).filter((f) => (WRITABLE_FIELDS as readonly string[]).includes(f));
    expect(cruce).toEqual([]);
  });

  it('WRITABLE_FIELDS no tiene repetidos (la canonicalización depende de su orden)', () => {
    expect(new Set(WRITABLE_FIELDS).size).toBe(WRITABLE_FIELDS.length);
  });

  it('el vocabulario público de @vpw/shared NO se desincroniza del normalizador', () => {
    // Sin esta paridad el panel podría ofrecer un modelo/campo que el normalizador rechaza,
    // y el owner vería una propiedad "válida" que en el servidor degrada a cero escrituras.
    expect([...SHARED_FIELDS]).toEqual([...WRITABLE_FIELDS]);
    expect([...SHARED_MODELS]).toEqual([...CATALOG_OWNERSHIP_MODELS]);
    expect([...SHARED_KINDS]).toEqual([...EXTERNAL_SOURCE_KINDS]);
  });

  it('OWNERSHIP_DEGRADED es la degradación canónica y está congelada', () => {
    expect(OWNERSHIP_DEGRADED.writable).toEqual([]);
    expect(OWNERSHIP_DEGRADED.modeCeiling).toBe('dry_run');
    expect(OWNERSHIP_DEGRADED.degraded).toBe(true);
    expect(Object.isFrozen(OWNERSHIP_DEGRADED)).toBe(true);
  });
});

/**
 * Paridad a nivel de TIPOS: si alguien agrega un valor de UN solo lado, el typecheck
 * (`pnpm -r typecheck`) falla acá aunque los tests en runtime pasen.
 */
type Igual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _paridadCampos: Igual<WritableField, SharedWritableField> = true;
const _paridadModelos: Igual<CatalogOwnershipModel, SharedModel> = true;
const _paridadKinds: Igual<ExternalSourceKind, SharedKind> = true;
const _paridadMotivos: Igual<OwnershipDegradedReason, SharedReason> = true;
void _paridadCampos;
void _paridadModelos;
void _paridadKinds;
void _paridadMotivos;

// ---------------------------------------------------------------------------
// Ausencia y forma inválida
// ---------------------------------------------------------------------------

describe('normalizeCatalogOwnership — ausencia y forma', () => {
  it.each([
    ['undefined (documento sin el campo)', undefined],
    ['null explícito', null],
  ])('%s ⇒ ownership_missing', (_label, raw) => {
    esperarDegradada(normalizeCatalogOwnership(raw), 'ownership_missing');
  });

  it('documento LEGACY (solo sourceOfTruth) jamás se interpreta como permiso de escritura', () => {
    // Es el documento real de arfagi antes de la migración: `sourceOfTruth:'vendeyapy'` decía
    // que mandábamos nosotros mientras el feed del sitio gobernaba todo. Cae en `missing`.
    const catalogSync = { enabled: true, mode: 'live', catalogId: '123', sourceOfTruth: 'vendeyapy' } as Record<string, unknown>;
    esperarDegradada(normalizeCatalogOwnership(catalogSync.ownership), 'ownership_missing');
  });

  it.each([
    ['string', 'external_managed'],
    ['número', 3],
    ['booleano', true],
    ['array', [{ model: 'external_managed' }]],
  ])('%s ⇒ ownership_malformed', (_label, raw) => {
    esperarDegradada(normalizeCatalogOwnership(raw), 'ownership_malformed');
  });

  it.each([
    ['model ausente', {}],
    ['model desconocido', { model: 'meta_manda' }],
    ['model con mayúsculas', { model: 'EXTERNAL_MANAGED' }],
    ['model con espacios', { model: ' external_managed ' }],
    ['model no string', { model: 1 }],
  ])('%s ⇒ ownership_malformed', (_label, raw) => {
    esperarDegradada(normalizeCatalogOwnership(raw), 'ownership_malformed');
  });

  it.each([
    ['ownedFields string', { model: 'vendeyapy_managed', ownedFields: 'price' }],
    ['ownedFields null', { model: 'vendeyapy_managed', ownedFields: null }],
    ['ownedFields con elemento no string', { model: 'vendeyapy_managed', ownedFields: ['price', 7] }],
    ['ownedFields con campo desconocido', { model: 'vendeyapy_managed', ownedFields: ['price', 'sale_price'] }],
  ])('%s ⇒ ownership_malformed', (_label, raw) => {
    esperarDegradada(normalizeCatalogOwnership(raw), 'ownership_malformed');
  });
});

// ---------------------------------------------------------------------------
// Campos internos: jamás delegables ni publicables
// ---------------------------------------------------------------------------

describe('normalizeCatalogOwnership — campos NUNCA publicables', () => {
  it.each([...NEVER_PUBLISHABLE])('declarar %s como propio ⇒ ownership_never_publishable', (campo) => {
    esperarDegradada(
      normalizeCatalogOwnership({ model: 'vendeyapy_managed', ownedFields: ['price', campo] }),
      'ownership_never_publishable',
    );
  });

  it('declararlo del lado EXTERNO tampoco: el costo no se delega a un feed', () => {
    esperarDegradada(
      normalizeCatalogOwnership({
        model: 'external_managed',
        ownedFields: [],
        external: feedValido({ declaredFields: ['price', 'cost'] }),
      }),
      'ownership_never_publishable',
    );
  });

  it('el campo interno gana sobre el desconocido: nunca se reporta como simple malformación', () => {
    // Mezcla deliberada: un campo interno + uno inexistente. El motivo debe ser el GRAVE,
    // porque "alguien intentó publicar el costo" es un incidente, no un typo.
    esperarDegradada(
      normalizeCatalogOwnership({ model: 'vendeyapy_managed', ownedFields: ['sale_price', 'aiFicha'] }),
      'ownership_never_publishable',
    );
  });
});

// ---------------------------------------------------------------------------
// Declaración de la fuente externa
// ---------------------------------------------------------------------------

describe('normalizeCatalogOwnership — declaración de la fuente externa', () => {
  it.each([
    ['kind ausente', feedValido({ kind: undefined })],
    ['kind desconocido', feedValido({ kind: 'google_sheet' })],
    ['external string', 'meta_feed'],
    ['external array', [feedValido()]],
  ])('%s ⇒ external_declaration_invalid', (_label, external) => {
    esperarDegradada(
      normalizeCatalogOwnership({ model: 'external_managed', ownedFields: [], external }),
      'external_declaration_invalid',
    );
  });

  it.each([
    ['sin ids reconocidos', feedValido({ acknowledgedSourceIds: [] })],
    ['ids ausentes', feedValido({ acknowledgedSourceIds: undefined })],
    ['ids no string', feedValido({ acknowledgedSourceIds: [12345] })],
    ['ids solo espacios', feedValido({ acknowledgedSourceIds: ['   '] })],
  ])('meta_feed %s ⇒ external_declaration_invalid (reconocer sin id es una promesa vacía)', (_label, external) => {
    esperarDegradada(
      normalizeCatalogOwnership({ model: 'external_managed', ownedFields: [], external }),
      'external_declaration_invalid',
    );
  });

  it.each([
    ['sin fingerprint', feedValido({ fingerprint: '' })],
    ['fingerprint solo espacios', feedValido({ fingerprint: '   ' })],
    ['fingerprint no string', feedValido({ fingerprint: 42 })],
    ['sin uid de quien reconoció', feedValido({ acknowledgedByUid: '' })],
    ['uid no string', feedValido({ acknowledgedByUid: null })],
  ])('%s ⇒ external_declaration_invalid (sin trazabilidad no hay permiso)', (_label, external) => {
    esperarDegradada(
      normalizeCatalogOwnership({ model: 'external_managed', ownedFields: [], external }),
      'external_declaration_invalid',
    );
  });

  it('declaredFields inválidos ⇒ external_declaration_invalid (no se adivina qué publica)', () => {
    esperarDegradada(
      normalizeCatalogOwnership({ model: 'external_managed', ownedFields: [], external: feedValido({ declaredFields: ['precio'] }) }),
      'external_declaration_invalid',
    );
  });

  it('commerce_manager y other_api NO exigen ids (no siempre existe un data source con id)', () => {
    for (const kind of ['commerce_manager', 'other_api'] as const) {
      const r = normalizeCatalogOwnership({
        model: 'external_managed',
        ownedFields: [],
        external: feedValido({ kind, acknowledgedSourceIds: [] }),
      });
      expect(r.degraded).toBe(false);
      expect(r.externalSource?.kind).toBe(kind);
      expect(r.externalSource?.acknowledgedSourceIds).toEqual([]);
    }
  });

  it('los ids se canonicalizan: recortados, deduplicados y ordenados', () => {
    const r = normalizeCatalogOwnership({
      model: 'external_managed',
      ownedFields: [],
      external: feedValido({ acknowledgedSourceIds: [' ds-9 ', 'ds-1', 'ds-9', 'ds-1'] }),
    });
    expect(r.externalSource?.acknowledgedSourceIds).toEqual(['ds-1', 'ds-9']);
  });

  it('la huella y el uid se conservan recortados, y acknowledgedAt viaja tal cual', () => {
    const r = normalizeCatalogOwnership({
      model: 'external_managed',
      ownedFields: [],
      external: feedValido({ fingerprint: '  huella-saneada  ', acknowledgedByUid: ' uid-owner ' }),
    });
    expect(r.externalSource?.fingerprint).toBe('huella-saneada');
    expect(r.externalSource?.acknowledgedByUid).toBe('uid-owner');
    expect(r.externalSource?.acknowledgedAt).toEqual({ seconds: 1, nanoseconds: 0 });
  });

  it('acknowledgedAt ausente queda null (no se inventa una fecha de reconocimiento)', () => {
    const r = normalizeCatalogOwnership({
      model: 'external_managed',
      ownedFields: [],
      external: feedValido({ acknowledgedAt: undefined }),
    });
    expect(r.externalSource?.acknowledgedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Un campo, un dueño
// ---------------------------------------------------------------------------

describe('normalizeCatalogOwnership — invariante "un campo, un dueño"', () => {
  it('el mismo campo declarado de los dos lados ⇒ ownership_conflict (dos escritores = loop)', () => {
    esperarDegradada(
      normalizeCatalogOwnership({
        model: 'hybrid',
        ownedFields: ['price', 'inventory'],
        external: feedValido({ declaredFields: ['title', 'price'] }),
      }),
      'ownership_conflict',
    );
  });

  it('particiones disjuntas del mismo campo público NO chocan', () => {
    const r = normalizeCatalogOwnership({
      model: 'hybrid',
      ownedFields: ['price', 'inventory'],
      external: feedValido({ declaredFields: ['title', 'description'] }),
    });
    expect(r.degraded).toBe(false);
    expect(r.writable).toEqual(['price', 'inventory']);
    expect(r.external).toEqual(['title', 'description']);
  });
});

// ---------------------------------------------------------------------------
// Semántica de los tres modelos
// ---------------------------------------------------------------------------

describe('normalizeCatalogOwnership — external_managed', () => {
  it('feed reconocido que publica todo ⇒ cero campos escribibles y techo dry_run, sin degradar', () => {
    const r = normalizeCatalogOwnership({
      model: 'external_managed',
      ownedFields: [],
      external: feedValido({ declaredFields: [...WRITABLE_FIELDS] }),
      lastSourceCheckAt: { seconds: 9, nanoseconds: 0 },
    });
    expect(r.degraded).toBe(false);
    expect(r.reasons).toEqual([]);
    expect(r.model).toBe('external_managed');
    // El corazón de la decisión: sin campos propios NO existe patch posible, así que el loop
    // diario del feed contra nuestras escrituras es inalcanzable por construcción.
    expect(r.writable).toEqual([]);
    expect(r.external).toEqual([...WRITABLE_FIELDS]);
    expect(r.modeCeiling).toBe('dry_run');
  });

  it('ownedFields con contenido contradice el modelo ⇒ ownership_conflict', () => {
    esperarDegradada(
      normalizeCatalogOwnership({ model: 'external_managed', ownedFields: ['price'], external: feedValido() }),
      'ownership_conflict',
    );
  });

  /**
   * CONTRATO CAMBIADO (fix de este programa). Antes `external` reflejaba literalmente
   * `declaredFields`, así que un feed reconocido sin columnas informadas —el caso NORMAL, porque
   * no le pedimos columnas a Graph— dejaba la lista de campos externos VACÍA. Con esa lista
   * vacía el guard de deriva del bot queda INERTE (`camposExternos()` no devuelve nada y la
   * clasificación corta antes de mirar el estado): un producto `drifted_external` con el precio
   * divergente se reportaba como "sin deriva" y cerraba venta igual. Bajo `external_managed`
   * `ownedFields` es vacío por definición, así que TODOS los campos públicos son de la fuente.
   */
  it('declaredFields VACÍA ⇒ los campos externos EFECTIVOS son todos los públicos', () => {
    const r = normalizeCatalogOwnership({
      model: 'external_managed',
      ownedFields: [],
      external: feedValido({ declaredFields: [] }),
    });
    expect(r.degraded).toBe(false);
    expect(r.writable).toEqual([]);
    expect(r.external).toEqual([...WRITABLE_FIELDS]);
    // La DECLARACIÓN se conserva tal cual: es evidencia de lo que la fuente dijo publicar.
    expect(r.externalSource?.declaredFields).toEqual([]);
    // Y los campos comerciales —los únicos que cortan una venta— están cubiertos.
    for (const f of ['price', 'currency', 'availability', 'inventory'] as const) expect(r.external).toContain(f);
  });

  it('declaredFields PARCIAL tampoco achica el gobierno externo bajo este modelo', () => {
    const r = normalizeCatalogOwnership({
      model: 'external_managed',
      ownedFields: [],
      external: feedValido({ declaredFields: ['title', 'image'] }),
    });
    expect(r.external).toEqual([...WRITABLE_FIELDS]);
    expect(r.externalSource?.declaredFields).toEqual(['title', 'image']);
  });

  it('SIN fuente externa reconocida ⇒ external_required (no se declara un dueño anónimo)', () => {
    // Fix de este programa: antes esto devolvía una propiedad "sana" (degraded:false) que decía
    // "manda una fuente externa" sin nombrar ninguna. Práctica­mente no se podía escribir, pero
    // el panel lo mostraba en verde y NUNCA se disparaba la alerta administrativa del nivel 2:
    // sin `external` no hay ids, ni huella, ni a quién comparar en el chequeo previo al POST.
    esperarDegradada(normalizeCatalogOwnership({ model: 'external_managed', ownedFields: [] }), 'external_required');
    esperarDegradada(normalizeCatalogOwnership({ model: 'external_managed', ownedFields: [], external: null }), 'external_required');
  });
});

describe('normalizeCatalogOwnership — vendeyapy_managed', () => {
  it('campos propios declarados ⇒ escribibles y techo live', () => {
    const r = normalizeCatalogOwnership({ model: 'vendeyapy_managed', ownedFields: ['price', 'availability'] });
    expect(r.degraded).toBe(false);
    expect(r.writable).toEqual(['price', 'availability']);
    expect(r.external).toEqual([]);
    expect(r.externalSource).toBeNull();
    expect(r.modeCeiling).toBe('live');
  });

  it.each([
    ['ownedFields ausente', { model: 'vendeyapy_managed' }],
    ['ownedFields vacío', { model: 'vendeyapy_managed', ownedFields: [] }],
    ['ownedFields con repetidos que colapsan a vacío', { model: 'vendeyapy_managed', ownedFields: [] }],
  ])('%s ⇒ owned_fields_required (gobernar "nada" no es gobernar)', (_label, raw) => {
    esperarDegradada(normalizeCatalogOwnership(raw), 'owned_fields_required');
  });

  it('con una fuente externa que PUBLICA campos ⇒ ownership_conflict (el modelo correcto es hybrid)', () => {
    esperarDegradada(
      normalizeCatalogOwnership({
        model: 'vendeyapy_managed',
        ownedFields: ['title'],
        external: feedValido({ declaredFields: ['price'] }),
      }),
      'ownership_conflict',
    );
  });

  /**
   * CONTRATO CAMBIADO (fix de este programa). Antes este caso se aceptaba: una fuente externa
   * reconocida con `declaredFields: []` dejaba `writable` COMPLETO y techo `live`, con el
   * argumento de que `ownedFields ∩ declaredFields = ∅` se cumplía. El problema es que esa
   * lista vacía NO es un caso raro sino el NORMAL: el cliente nunca le pide columnas a Graph,
   * así que casi toda fuente detectada llega sin campos. El resultado era el loop diario
   * (feed revierte → planificador detecta → apply reescribe) exactamente en el modelo que el
   * ADR-0015 §3 declara imposible. Hoy la MERA PRESENCIA de la declaración externa alcanza.
   */
  it('una fuente reconocida SIN campos declarados también ⇒ ownership_conflict', () => {
    esperarDegradada(
      normalizeCatalogOwnership({
        model: 'vendeyapy_managed',
        ownedFields: ['title'],
        external: feedValido({ declaredFields: [] }),
      }),
      'ownership_conflict',
    );
  });

  it('la lista externa vacía NO abre una puerta trasera a live con TODOS los campos propios', () => {
    // Test discriminante del hallazgo: con el bug, esto devolvía writable = los 10 campos
    // públicos y `effectiveMode('live', …) === 'live'` — permiso total de escritura frente a un
    // feed reconocido. Cualquiera de los tres kinds reproduce el escenario.
    for (const kind of ['meta_feed', 'commerce_manager', 'other_api'] as const) {
      const r = normalizeCatalogOwnership({
        model: 'vendeyapy_managed',
        ownedFields: [...WRITABLE_FIELDS],
        external: feedValido({ kind, declaredFields: [] }),
      });
      expect(r.writable).toEqual([]);
      expect(r.reasons).toEqual(['ownership_conflict']);
      expect(effectiveMode('live', r)).toBe('dry_run');
    }
  });

  it('sin fuente externa declarada el modelo sigue siendo válido (external: null / ausente)', () => {
    for (const raw of [
      { model: 'vendeyapy_managed', ownedFields: ['title'] },
      { model: 'vendeyapy_managed', ownedFields: ['title'], external: null },
    ]) {
      const r = normalizeCatalogOwnership(raw);
      expect(r.degraded).toBe(false);
      expect(r.writable).toEqual(['title']);
      expect(r.modeCeiling).toBe('live');
    }
  });
});

describe('normalizeCatalogOwnership — hybrid', () => {
  it('matriz explícita de los dos lados ⇒ escribibles solo los propios, techo live', () => {
    const r = normalizeCatalogOwnership({
      model: 'hybrid',
      ownedFields: ['inventory', 'availability'],
      external: feedValido({ declaredFields: ['title', 'image'] }),
    });
    expect(r.degraded).toBe(false);
    expect(r.writable).toEqual(['availability', 'inventory']);
    expect(r.external).toEqual(['title', 'image']);
    expect(r.modeCeiling).toBe('live');
  });

  it('sin campos propios ⇒ owned_fields_required', () => {
    esperarDegradada(
      normalizeCatalogOwnership({ model: 'hybrid', ownedFields: [], external: feedValido() }),
      'owned_fields_required',
    );
  });

  it.each([
    ['sin external', { model: 'hybrid', ownedFields: ['price'] }],
    ['external null', { model: 'hybrid', ownedFields: ['price'], external: null }],
    ['external sin campos declarados', { model: 'hybrid', ownedFields: ['price'], external: feedValido({ declaredFields: [] }) }],
  ])('%s ⇒ hybrid_partition_missing (la propiedad JAMÁS se infiere)', (_label, raw) => {
    esperarDegradada(normalizeCatalogOwnership(raw), 'hybrid_partition_missing');
  });
});

// ---------------------------------------------------------------------------
// Canonicalización de listas
// ---------------------------------------------------------------------------

describe('normalizeCatalogOwnership — canonicalización', () => {
  it('ordena por el orden del contrato, deduplica y recorta espacios', () => {
    const r = normalizeCatalogOwnership({
      model: 'vendeyapy_managed',
      ownedFields: ['url', ' price ', 'price', 'title', 'url'],
    });
    expect(r.writable).toEqual(['title', 'price', 'url']);
  });

  it('dos declaraciones equivalentes producen listas IDÉNTICAS (huella estable del permiso)', () => {
    const a = normalizeCatalogOwnership({ model: 'vendeyapy_managed', ownedFields: ['price', 'title'] });
    const b = normalizeCatalogOwnership({ model: 'vendeyapy_managed', ownedFields: ['title', 'price', 'price'] });
    expect(a.writable).toEqual(b.writable);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('la lista externa también se canonicaliza', () => {
    // Se prueba con `hybrid` porque es el modelo donde `external` ES la lista declarada. Con
    // `external_managed` el gobierno externo abarca todos los campos públicos por definición
    // del modelo (ver el bloque de external_managed), así que la canonicalización se observa
    // sobre la declaración persistida.
    const r = normalizeCatalogOwnership({
      model: 'hybrid',
      ownedFields: ['price'],
      external: feedValido({ declaredFields: ['url', 'title', 'title'] }),
    });
    expect(r.external).toEqual(['title', 'url']);
    expect(r.externalSource?.declaredFields).toEqual(['title', 'url']);
  });

  it('external_managed canonicaliza la DECLARACIÓN aunque el gobierno efectivo sea total', () => {
    const r = normalizeCatalogOwnership({
      model: 'external_managed',
      ownedFields: [],
      external: feedValido({ declaredFields: ['url', ' title ', 'title'] }),
    });
    expect(r.externalSource?.declaredFields).toEqual(['title', 'url']);
    expect(r.external).toEqual([...WRITABLE_FIELDS]);
  });
});

// ---------------------------------------------------------------------------
// Consultas de los gates
// ---------------------------------------------------------------------------

describe('ownsField / fieldsNotOwned', () => {
  const propia = normalizeCatalogOwnership({
    model: 'hybrid',
    ownedFields: ['price', 'inventory'],
    external: feedValido({ declaredFields: ['title'] }),
  });

  it('ownsField responde solo por los campos propios', () => {
    expect(ownsField(propia, 'price')).toBe(true);
    expect(ownsField(propia, 'inventory')).toBe(true);
    expect(ownsField(propia, 'title')).toBe(false); // es de la fuente externa
    expect(ownsField(propia, 'brand')).toBe(false); // de nadie
  });

  it('con propiedad degradada NINGÚN campo es propio', () => {
    for (const f of WRITABLE_FIELDS) expect(ownsField(OWNERSHIP_DEGRADED, f)).toBe(false);
  });

  it('fieldsNotOwned devuelve vacío solo si TODO el patch es nuestro', () => {
    expect(fieldsNotOwned(propia, ['price'])).toEqual([]);
    expect(fieldsNotOwned(propia, ['price', 'inventory'])).toEqual([]);
    expect(fieldsNotOwned(propia, [])).toEqual([]);
  });

  it('marca los campos externos, los de nadie y los que ni existen en el contrato', () => {
    expect(fieldsNotOwned(propia, ['price', 'title'])).toEqual(['title']);
    expect(fieldsNotOwned(propia, ['brand'])).toEqual(['brand']);
    expect(fieldsNotOwned(propia, ['sale_price'])).toEqual(['sale_price']);
  });

  it('un campo INTERNO en el patch nunca pasa, ni siquiera con propiedad sana', () => {
    for (const interno of NEVER_PUBLISHABLE) expect(fieldsNotOwned(propia, [interno])).toEqual([interno]);
  });

  it('con propiedad degradada TODO el patch queda afuera', () => {
    expect(fieldsNotOwned(OWNERSHIP_DEGRADED, [...WRITABLE_FIELDS])).toEqual([...WRITABLE_FIELDS]);
  });
});

// ---------------------------------------------------------------------------
// Modo efectivo: el techo de la propiedad manda sobre la config de ejecución
// ---------------------------------------------------------------------------

describe('effectiveMode — techo de la propiedad', () => {
  const conTecho = (ceiling: 'dry_run' | 'live'): EffectiveOwnership =>
    ceiling === 'live'
      ? normalizeCatalogOwnership({ model: 'vendeyapy_managed', ownedFields: ['price'] })
      : normalizeCatalogOwnership({ model: 'external_managed', ownedFields: [], external: feedValido() });

  it('off manda siempre (nivel 1 apagado no lo levanta ninguna propiedad)', () => {
    expect(effectiveMode('off', conTecho('live'))).toBe('off');
    expect(effectiveMode('off', OWNERSHIP_DEGRADED)).toBe('off');
  });

  it('live con techo live ⇒ live', () => {
    expect(effectiveMode('live', conTecho('live'))).toBe('live');
  });

  it('live con techo dry_run ⇒ dry_run (aunque alguien ponga live por error)', () => {
    expect(effectiveMode('live', conTecho('dry_run'))).toBe('dry_run');
    expect(effectiveMode('live', OWNERSHIP_DEGRADED)).toBe('dry_run');
  });

  it('dry_run jamás se promueve a live', () => {
    expect(effectiveMode('dry_run', conTecho('live'))).toBe('dry_run');
    expect(effectiveMode('dry_run', OWNERSHIP_DEGRADED)).toBe('dry_run');
  });
});

// ---------------------------------------------------------------------------
// Propiedad transversal: degradada ⇒ imposible escribir
// ---------------------------------------------------------------------------

describe('invariante global del fail-closed', () => {
  const entradasRotas: unknown[] = [
    undefined,
    null,
    'external_managed',
    [],
    {},
    { model: 'hybrid' },
    { model: 'vendeyapy_managed', ownedFields: [] },
    { model: 'vendeyapy_managed', ownedFields: ['cost'] },
    { model: 'external_managed', ownedFields: ['price'], external: feedValido() },
    { model: 'external_managed', ownedFields: [] },
    { model: 'hybrid', ownedFields: ['price'], external: feedValido({ declaredFields: ['price'] }) },
    { model: 'hybrid', ownedFields: ['price'], external: feedValido({ fingerprint: '' }) },
  ];

  it('ninguna entrada inválida deja UN solo campo escribible ni permite live', () => {
    for (const raw of entradasRotas) {
      const r = normalizeCatalogOwnership(raw);
      expect(r.degraded).toBe(true);
      expect(r.writable).toEqual([]);
      expect(effectiveMode('live', r)).toBe('dry_run');
      expect(r.reasons.length).toBeGreaterThan(0);
    }
  });

  it('el resultado degradado NO comparte estado mutable con la constante congelada', () => {
    // `degradado()` clona las listas: un consumidor descuidado que haga push no puede
    // contaminar la constante global (y con ella, la propiedad de todos los tenants).
    const r = normalizeCatalogOwnership(undefined);
    (r.writable as WritableField[]).push('price');
    expect(OWNERSHIP_DEGRADED.writable).toEqual([]);
    expect(normalizeCatalogOwnership(undefined).writable).toEqual([]);
  });
});
