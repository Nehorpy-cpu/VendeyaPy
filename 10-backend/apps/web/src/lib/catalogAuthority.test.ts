/**
 * catalogAuthority.test.ts — Helpers PUROS de autoridad de catálogo (ADR-0022).
 *
 * El backend se implementa en paralelo: estos tests fijan la normalización tolerante del
 * eje `authority`, la traducción de bloqueos/kinds (ids cerrados del contrato), la
 * frescura del espejo (§5) y la derivación de campos gobernados para la edición honesta.
 * Regla dura: ante cualquier duda, FAIL-CLOSED (null / sin permisos nuevos).
 */
import { describe, it, expect } from 'vitest';
import type { Product } from '@vpw/shared';
import { normalizarOwnershipStatus, type ProductInput } from './catalog';
import {
  antiguedadLegible,
  bloqueoLlevaAIntegraciones,
  camposGobernadosCambiados,
  camposGobernadosPorFuente,
  consecuenciasDe,
  esPreviewInvalidado,
  esSalidaDeManaged,
  etiquetaBloqueo,
  etiquetaCombo,
  etiquetaKindApply,
  frescuraEspejo,
  kindDeError,
  motivoBloqueoPorRelacion,
  nombreFuentePublicadora,
  normalizarAutoridad,
  normalizarAuthorityPreview,
  tiempoRestanteTexto,
  UMBRAL_ESPEJO_VIEJO_MS,
  type CatalogAuthorityView,
} from './catalogAuthority';

const HORA = 60 * 60 * 1000;
const AHORA = 1_800_000_000_000; // fijo: nada depende del reloj real

const vista = (over?: Partial<CatalogAuthorityView>): CatalogAuthorityView => ({
  autoridad: 'external',
  relacion: 'mirror',
  declarada: true,
  motivos: [],
  frescura: { verificadoEn: null, fuenteLeidaEn: null, importadoEn: null },
  ...over,
});

describe('normalizarAutoridad — contrato ADR-0022 §1', () => {
  it('acepta el shape del contrato con staleness en epoch ms', () => {
    const v = normalizarAutoridad({
      authority: 'meta',
      relationship: 'mirror',
      declared: true,
      reasons: ['relationship_incoherent'],
      staleness: { metaVerifiedAt: AHORA - 2 * HORA, lastSourceCheckAt: AHORA - HORA, lastImportFinishedAt: AHORA - 3 * HORA },
    });
    expect(v).not.toBeNull();
    expect(v!.autoridad).toBe('meta');
    expect(v!.relacion).toBe('mirror');
    expect(v!.declarada).toBe(true);
    expect(v!.motivos).toEqual(['relationship_incoherent']);
    expect(v!.frescura.fuenteLeidaEn?.getTime()).toBe(AHORA - HORA);
    expect(v!.frescura.verificadoEn?.getTime()).toBe(AHORA - 2 * HORA);
    expect(v!.frescura.importadoEn?.getTime()).toBe(AHORA - 3 * HORA);
  });

  it('tolera segundos epoch en staleness (no cae en 1970)', () => {
    const v = normalizarAutoridad({
      authority: 'vendeyapy',
      relationship: 'none',
      declared: false,
      reasons: [],
      staleness: { lastSourceCheckAt: Math.floor((AHORA - HORA) / 1000) },
    });
    expect(v!.frescura.fuenteLeidaEn!.getFullYear()).toBeGreaterThan(2020);
  });

  it('FAIL-CLOSED: sin eje, con valores fuera del contrato o shape roto ⇒ null', () => {
    expect(normalizarAutoridad(undefined)).toBeNull();
    expect(normalizarAutoridad(null)).toBeNull();
    expect(normalizarAutoridad('meta')).toBeNull();
    expect(normalizarAutoridad({ authority: 'shopify', relationship: 'mirror' })).toBeNull();
    expect(normalizarAutoridad({ authority: 'meta', relationship: 'full_control' })).toBeNull();
    expect(normalizarAutoridad({ relationship: 'mirror' })).toBeNull();
  });

  it('declared solo es true con `declared: true` explícito (derivado legacy por defecto)', () => {
    const v = normalizarAutoridad({ authority: 'vendeyapy', relationship: 'managed', reasons: [], staleness: {} });
    expect(v!.declarada).toBe(false);
  });

  it('viaja dentro de normalizarOwnershipStatus como `autoridad` (null sin contrato nuevo)', () => {
    const con = normalizarOwnershipStatus({
      enabled: true,
      configMode: 'dry_run',
      ownership: { model: 'external_managed', writable: [], degraded: false, reasons: [] },
      authority: { authority: 'external', relationship: 'mirror', declared: true, reasons: [], staleness: {} },
    });
    expect(con.autoridad?.autoridad).toBe('external');
    expect(con.autoridad?.relacion).toBe('mirror');

    const sin = normalizarOwnershipStatus({
      enabled: true,
      configMode: 'live',
      ownership: { model: 'vendeyapy_managed', writable: ['title'], degraded: false, reasons: [] },
    });
    expect(sin.autoridad).toBeNull();
  });
});

describe('normalizarAuthorityPreview', () => {
  it('normaliza la respuesta feliz con planHash, runId y vencimiento', () => {
    const p = normalizarAuthorityPreview({
      ok: true,
      resumen: 'Pasa a espejo de Meta.',
      bloqueos: [],
      advertencias: ['El espejo se refresca al importar.'],
      estadoEsperado: { authority: 'meta', relationship: 'mirror' },
      planHash: 'ph-1',
      runId: 'run-1',
      expiresAt: AHORA + 10 * 60_000,
    });
    expect(p.ok).toBe(true);
    expect(p.resumen).toBe('Pasa a espejo de Meta.');
    expect(p.planHash).toBe('ph-1');
    expect(p.runId).toBe('run-1');
    expect(p.estadoEsperado).toEqual({ authority: 'meta', relationship: 'mirror' });
    expect(p.venceEn?.getTime()).toBe(AHORA + 10 * 60_000);
    expect(p.advertencias).toEqual(['El espejo se refresca al importar.']);
  });

  it('con bloqueos DESCARTA el planHash aunque el backend lo mande (fail-closed)', () => {
    const p = normalizarAuthorityPreview({
      ok: false,
      bloqueos: [{ id: 'outbox_not_terminal', detalle: '3 envíos' }, 'connection_missing'],
      planHash: 'ph-que-no-deberia-venir',
      runId: 'r',
    });
    expect(p.planHash).toBeNull();
    expect(p.bloqueos).toEqual([
      { id: 'outbox_not_terminal', detalle: '3 envíos' },
      { id: 'connection_missing', detalle: '' },
    ]);
  });

  it('sanea textos: un detalle con URL firmada jamás se pinta', () => {
    const p = normalizarAuthorityPreview({
      ok: false,
      bloqueos: [{ id: 'external_conflict', detalle: 'feed en https://x.com/feed.csv?token=secreto123 activo' }],
      advertencias: ['ver https://feed.example.com/x?sig=abc'],
    });
    expect(p.bloqueos[0]!.detalle).not.toMatch(/https|token|secreto/);
    expect(p.advertencias[0] ?? '').not.toMatch(/https|sig=/);
  });

  it('respuesta vacía o rota ⇒ nada aplicable', () => {
    const p = normalizarAuthorityPreview(undefined);
    expect(p.ok).toBe(false);
    expect(p.planHash).toBeNull();
    expect(p.runId).toBeNull();
    expect(p.bloqueos).toEqual([]);
  });
});

describe('traducciones de bloqueos y kinds (ids cerrados)', () => {
  it('traduce cada bloqueo del contrato sin exponer el id crudo', () => {
    expect(etiquetaBloqueo('outbox_not_terminal')).toBe('Hay envíos a Meta pendientes: resolvelos antes de cambiar el modo.');
    expect(etiquetaBloqueo('connection_missing')).toBe('Falta la conexión con Meta.');
    expect(etiquetaBloqueo('catalog_id_missing')).toBe('Falta configurar qué catálogo de Meta se usa.');
    for (const id of [
      'invalid_target',
      'ownership_incompatible',
      'external_conflict',
      'import_run_in_flight',
      'sync_run_in_flight',
      'mapping_ambiguous',
    ]) {
      expect(etiquetaBloqueo(id)).not.toContain('_');
    }
    // Id desconocido: mensaje genérico honesto, jamás el id crudo.
    expect(etiquetaBloqueo('rayo_cosmico')).toBe('Hay un requisito pendiente que impide este cambio.');
  });

  it('solo los requisitos de conexión llevan a Integración Meta', () => {
    expect(bloqueoLlevaAIntegraciones('connection_missing')).toBe(true);
    expect(bloqueoLlevaAIntegraciones('catalog_id_missing')).toBe(true);
    expect(bloqueoLlevaAIntegraciones('outbox_not_terminal')).toBe(false);
  });

  it('traduce los kinds del apply, con los textos comprometidos', () => {
    expect(etiquetaKindApply('expired')).toBe('El preview venció, generá uno nuevo.');
    expect(etiquetaKindApply('concurrent_change')).toContain('cambió mientras revisabas');
    expect(etiquetaKindApply('consumed')).toContain('ya se usó');
    expect(etiquetaKindApply('desconocido')).toBe('No se pudo aplicar el cambio. Generá una previsualización nueva.');
    expect(etiquetaKindApply(null)).toBe('No se pudo aplicar el cambio. Generá una previsualización nueva.');
  });

  it('kindDeError lee details.kind y cae al kind incrustado en el mensaje', () => {
    expect(kindDeError({ code: 'functions/failed-precondition', message: 'x', details: { kind: 'expired' } })).toBe('expired');
    expect(kindDeError({ message: 'failed-precondition: concurrent_change' })).toBe('concurrent_change');
    expect(kindDeError({ message: 'otra cosa' })).toBeNull();
    expect(kindDeError(null)).toBeNull();
  });

  it('esPreviewInvalidado: los kinds de evidencia obligan a regenerar; el gating no', () => {
    for (const k of ['preview_required', 'not_found', 'mismatch', 'expired', 'consumed', 'actor_mismatch', 'concurrent_change']) {
      expect(esPreviewInvalidado(k)).toBe(true);
    }
    expect(esPreviewInvalidado('authority_relationship_blocked')).toBe(false);
    expect(esPreviewInvalidado(null)).toBe(false);
  });
});

describe('frescura del espejo (§5)', () => {
  it('antiguedadLegible: recién / minutos / horas / días', () => {
    expect(antiguedadLegible(new Date(AHORA - 20_000), AHORA)).toBe('recién');
    expect(antiguedadLegible(new Date(AHORA - 5 * 60_000), AHORA)).toBe('hace 5 minutos');
    expect(antiguedadLegible(new Date(AHORA - 2 * HORA), AHORA)).toBe('hace 2 horas');
    expect(antiguedadLegible(new Date(AHORA - 3 * 24 * HORA), AHORA)).toBe('hace 3 días');
    expect(antiguedadLegible(new Date(AHORA - HORA), AHORA)).toBe('hace 1 hora');
  });

  it('frescuraEspejo: toma la evidencia MÁS RECIENTE y marca viejo pasadas las 48 h', () => {
    const fresco = frescuraEspejo(
      vista({
        frescura: {
          verificadoEn: new Date(AHORA - 3 * 24 * HORA),
          fuenteLeidaEn: new Date(AHORA - 2 * HORA),
          importadoEn: null,
        },
      }),
      AHORA,
    );
    expect(fresco.ultima?.getTime()).toBe(AHORA - 2 * HORA);
    expect(fresco.vieja).toBe(false);

    const viejo = frescuraEspejo(
      vista({ frescura: { verificadoEn: null, fuenteLeidaEn: new Date(AHORA - UMBRAL_ESPEJO_VIEJO_MS - HORA), importadoEn: null } }),
      AHORA,
    );
    expect(viejo.vieja).toBe(true);
  });

  it('sin NINGUNA lectura real: ultima null (jamás «verificado» sin timestamp)', () => {
    expect(frescuraEspejo(vista(), AHORA)).toEqual({ ultima: null, vieja: false });
    expect(frescuraEspejo(null, AHORA)).toEqual({ ultima: null, vieja: false });
  });

  it('tiempoRestanteTexto: minutos y segundos', () => {
    expect(tiempoRestanteTexto(9 * 60_000 + 30_000)).toBe('9 min');
    expect(tiempoRestanteTexto(45_000)).toBe('45 s');
    expect(tiempoRestanteTexto(0)).toBe('0 s');
  });
});

describe('gating por relación (§4)', () => {
  it('none: solo bot; mirror: nombra a la fuente; managed y sin contrato: sin bloqueo nuevo', () => {
    expect(motivoBloqueoPorRelacion(vista({ relacion: 'none' }), '')).toBe(
      'El catálogo se usa solo para el bot: no se lee ni se envía nada a Meta.',
    );
    expect(motivoBloqueoPorRelacion(vista({ relacion: 'mirror' }), 'Catálogo del sitio')).toBe(
      'Este catálogo lo publica Catálogo del sitio; VendeYaPy no escribe en Meta.',
    );
    expect(motivoBloqueoPorRelacion(vista({ relacion: 'mirror' }), '')).toBe(
      'Este catálogo lo publica otro sistema; VendeYaPy no escribe en Meta.',
    );
    expect(motivoBloqueoPorRelacion(vista({ relacion: 'managed' }), 'x')).toBe('');
    expect(motivoBloqueoPorRelacion(null, 'x')).toBe('');
  });

  it('nombreFuentePublicadora: Meta con autoridad meta; el nombre saneado de la fuente si existe', () => {
    const conMeta = normalizarOwnershipStatus({
      enabled: true,
      configMode: 'dry_run',
      ownership: { model: 'external_managed', writable: [], degraded: false, reasons: [] },
      authority: { authority: 'meta', relationship: 'mirror', declared: true, reasons: [], staleness: {} },
    });
    expect(nombreFuentePublicadora(conMeta)).toBe('Meta');

    const conFuente = normalizarOwnershipStatus({
      enabled: true,
      configMode: 'dry_run',
      ownership: {
        model: 'external_managed',
        writable: [],
        external: ['price'],
        externalSource: { kind: 'meta_feed', name: 'Catálogo del sitio', acknowledgedByUid: 'u1', acknowledgedSourceIds: ['1'] },
        degraded: false,
        reasons: [],
      },
      authority: { authority: 'external', relationship: 'mirror', declared: true, reasons: [], staleness: {} },
    });
    expect(nombreFuentePublicadora(conFuente)).toBe('Catálogo del sitio');
    expect(nombreFuentePublicadora(null)).toBe('');
  });
});

describe('etiquetas y consecuencias del cambio', () => {
  it('etiquetaCombo: las cuatro combinaciones simples en criollo', () => {
    expect(etiquetaCombo('vendeyapy', 'none')).toBe('Lo administrás en VendeYaPy, solo para el bot');
    expect(etiquetaCombo('vendeyapy', 'managed')).toBe('Lo administrás en VendeYaPy y se publica en Meta');
    expect(etiquetaCombo('meta', 'mirror')).toBe('Lo administrás en Meta');
    expect(etiquetaCombo('external', 'mirror')).toBe('Lo publica otro sistema');
  });

  it('esSalidaDeManaged solo cuando se abandona la publicación activa', () => {
    expect(esSalidaDeManaged(vista({ relacion: 'managed' }), { authority: 'vendeyapy', relationship: 'none' })).toBe(true);
    expect(esSalidaDeManaged(vista({ relacion: 'managed' }), { authority: 'vendeyapy', relationship: 'managed' })).toBe(false);
    expect(esSalidaDeManaged(vista({ relacion: 'none' }), { authority: 'meta', relationship: 'mirror' })).toBe(false);
    expect(esSalidaDeManaged(null, { authority: 'vendeyapy', relationship: 'none' })).toBe(false);
  });

  it('consecuenciasDe SIEMPRE incluye el invariante de lo que no se toca', () => {
    for (const target of [
      { authority: 'vendeyapy', relationship: 'none' },
      { authority: 'meta', relationship: 'mirror' },
      { authority: 'vendeyapy', relationship: 'managed' },
    ] as const) {
      const lineas = consecuenciasDe(vista({ relacion: 'managed' }), target);
      expect(lineas[lineas.length - 1]).toContain('No se toca nada más');
    }
    expect(consecuenciasDe(vista({ relacion: 'managed' }), { authority: 'vendeyapy', relationship: 'none' }).join(' ')).toContain(
      'VendeYaPy deja de publicar en Meta',
    );
  });
});

describe('campos gobernados y edición honesta', () => {
  const ownExterno = normalizarOwnershipStatus({
    enabled: true,
    configMode: 'dry_run',
    ownership: {
      model: 'external_managed',
      writable: [],
      external: ['title', 'price'],
      degraded: false,
      reasons: [],
    },
  });

  it('camposGobernadosPorFuente: la lista externa; con external_managed sin lista, todos; propio ⇒ ninguno', () => {
    expect(camposGobernadosPorFuente(ownExterno)).toEqual(['title', 'price']);

    const todo = normalizarOwnershipStatus({
      enabled: true,
      configMode: 'dry_run',
      ownership: { model: 'external_managed', writable: [], degraded: false, reasons: [] },
    });
    expect(camposGobernadosPorFuente(todo)).toContain('price');
    expect(camposGobernadosPorFuente(todo)).toContain('image');

    const propio = normalizarOwnershipStatus({
      enabled: true,
      configMode: 'live',
      ownership: { model: 'vendeyapy_managed', writable: ['title', 'price'], degraded: false, reasons: [] },
    });
    expect(camposGobernadosPorFuente(propio)).toEqual([]);
    expect(camposGobernadosPorFuente(null)).toEqual([]);
  });

  const producto = {
    id: 'p1',
    name: 'Odyssey',
    brand: 'Armaf',
    description: 'desc',
    price: 250000,
    categoryId: 'perfumes',
    images: ['https://x/a.jpg'],
    productUrl: 'https://x/p',
    status: 'ACTIVE',
    inventory: { trackStock: true, stock: 5, lowStockThreshold: 2, sku: 'p1' },
  } as unknown as Product;

  const input = (over?: Partial<ProductInput>): ProductInput =>
    ({
      name: 'Odyssey',
      brand: 'Armaf',
      description: 'desc',
      price: 250000,
      compareAtPrice: null,
      costPrice: null,
      priorityScore: null,
      aiNotes: '',
      categoryId: 'perfumes',
      images: ['https://x/a.jpg'],
      emoji: '🌸',
      stock: 5,
      trackStock: true,
      lowStockThreshold: 2,
      sku: 'p1',
      status: 'ACTIVE',
      featured: false,
      productUrl: 'https://x/p',
      perfume: null,
      aiFicha: null,
      ...over,
    }) as ProductInput;

  it('detecta SOLO los cambios en campos gobernados', () => {
    expect(camposGobernadosCambiados(producto, input(), ['title', 'price'])).toEqual([]);
    expect(camposGobernadosCambiados(producto, input({ price: 300000 }), ['title', 'price'])).toEqual(['price']);
    expect(camposGobernadosCambiados(producto, input({ name: 'Otro nombre', price: 300000 }), ['title', 'price'])).toEqual([
      'title',
      'price',
    ]);
    // Cambio en un campo NO gobernado: no molesta.
    expect(camposGobernadosCambiados(producto, input({ description: 'nueva' }), ['title', 'price'])).toEqual([]);
    // Datos internos jamás cuentan (costo no es campo público).
    expect(camposGobernadosCambiados(producto, input({ costPrice: 99999 }), ['title', 'price'])).toEqual([]);
    // Sin campos gobernados no hay nada que confirmar.
    expect(camposGobernadosCambiados(producto, input({ price: 1 }), [])).toEqual([]);
  });

  it('el stock dispara availability/inventory cuando están gobernados', () => {
    expect(camposGobernadosCambiados(producto, input({ stock: 0 }), ['availability', 'inventory'])).toEqual([
      'availability',
      'inventory',
    ]);
  });

  it('B3: cambiar SOLO el status dispara availability (la disponibilidad publicada deriva de ACTIVE)', () => {
    // meta/catalogOutbound.ts:168 — availability = ACTIVE && stock. Pasar a INACTIVE cambia
    // lo publicado tanto como vaciar el stock: sin esto, ACTIVE↔INACTIVE guardaba en silencio.
    expect(camposGobernadosCambiados(producto, input({ status: 'INACTIVE' }), ['availability', 'inventory'])).toEqual([
      'availability',
    ]);
    expect(camposGobernadosCambiados(producto, input({ status: 'ACTIVE' }), ['availability', 'inventory'])).toEqual([]);
  });
});
