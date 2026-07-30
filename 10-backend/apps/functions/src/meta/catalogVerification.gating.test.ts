import { describe, it, expect, vi } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';

/**
 * ADR-0015 §6 + hallazgo B1 — Los DOS EJES aplicados a la reconciliación.
 *
 *  · PERMISO DE ESCRITURA  → lo decide el interruptor (`enabled`/`mode`). Intacto.
 *  · CAPACIDAD DE VERIFICAR → la decide que exista gobierno externo DECLARADO y un catálogo
 *    remoto que leer. Verificar es un GET: dejar de escribir no puede dejarnos ciegos.
 *
 * La regla que se defiende acá, y que salió del hallazgo: **si el guard está activo para un
 * tenant, lo que refresca la evidencia también tiene que poder correr para ese tenant.** Un
 * bloqueo permanente sin salida es tan malo como un verde sin evidencia.
 */
vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  catalogVerificationEligibility,
  catalogVerificationNotificationId,
  decideVerificationBlockedPatch,
} from './catalogVerification.js';
import { declaredExternalFields } from './catalogSyncConfig.js';
// El contrato de campos que decide si el guard del bot está ACTIVO. Se importa el del guard (no se
// re-declara acá) para que este test no pueda quedar atado a una lista propia que diverja.
import { CAMPOS_CRITICOS } from '../catalog/driftGuard.js';

const externa = (over: Record<string, unknown> = {}) => ({
  kind: 'meta_feed',
  acknowledgedSourceIds: ['feed-1'],
  declaredFields: [] as string[],
  fingerprint: 'huella-saneada',
  acknowledgedByUid: 'uid-owner',
  acknowledgedAt: null,
  ...over,
});

const propiedadExterna = () => ({ model: 'external_managed', ownedFields: [], external: externa(), lastSourceCheckAt: null });

/**
 * Híbrido con lo COMERCIAL de nuestro lado: el feed publica lo descriptivo y nada más. El guard
 * del bot queda INERTE con esta propiedad (solo se activa si la fuente externa gobierna un campo
 * comercial), así que sirve para el caso "no hay nada que refrescar".
 */
const propiedadHibrida = () => ({
  model: 'hybrid',
  ownedFields: ['price', 'inventory'],
  external: externa({ declaredFields: ['title', 'description', 'image'] }),
  lastSourceCheckAt: null,
});

/** Híbrido al revés: el feed publica el PRECIO y el stock; el texto lo escribimos nosotros. */
const propiedadHibridaComercial = () => ({
  model: 'hybrid',
  ownedFields: ['title', 'description'],
  external: externa({ declaredFields: ['price', 'inventory', 'image'] }),
  lastSourceCheckAt: null,
});

const cfg = (over: Record<string, unknown> = {}) => ({
  enabled: false,
  mode: 'off',
  catalogId: 'CAT-1',
  ownership: propiedadExterna(),
  ...over,
});

describe('catalogVerificationEligibility — verificar no depende del interruptor de escritura', () => {
  it('sync ENCENDIDA ⇒ corre por el camino de siempre, con la propiedad efectiva de la config', () => {
    const e = catalogVerificationEligibility(cfg({ enabled: true, mode: 'dry_run' }));
    expect(e).toMatchObject({ can: 'run', via: 'sync_enabled', catalogId: 'CAT-1' });
    if (e.can !== 'run') throw new Error('inalcanzable');
    expect(e.ownership.model).toBe('external_managed');
  });

  it('sync APAGADA (`enabled:false`) + gobierno externo ⇒ CORRE igual: el feed sigue publicando', () => {
    const e = catalogVerificationEligibility(cfg({ enabled: false }));
    expect(e).toMatchObject({ can: 'run', via: 'external_governance', catalogId: 'CAT-1' });
  });

  it('`mode:"off"` + gobierno externo ⇒ CORRE igual (apagar la sync no apaga la honestidad)', () => {
    const e = catalogVerificationEligibility(cfg({ enabled: true, mode: 'off' }));
    expect(e).toMatchObject({ can: 'run', via: 'external_governance' });
  });

  it('con la sync apagada la propiedad NO se degrada: se clasifica la deriva con el dueño real', () => {
    // CONTRATO CAMBIADO (hallazgo del review adversarial): el híbrido de este caso es el que TIENE
    // el guard activo —el feed publica el precio—, porque ese es el único híbrido que corre con la
    // sync apagada. Lo que el test defiende sigue siendo lo mismo: apagar el interruptor no degrada
    // la propiedad, así que la corrida puede decir de QUIÉN es cada divergencia.
    const e = catalogVerificationEligibility(cfg({ ownership: propiedadHibridaComercial() }));
    if (e.can !== 'run') throw new Error('debería correr');
    // `writable` viaja para CLASIFICAR de quién es cada divergencia (`drifted` vs
    // `drifted_external`), no como permiso: esta corrida solo hace GET.
    expect(e.ownership.writable).toEqual(['title', 'description']);
    expect(e.ownership.external).toEqual(['price', 'inventory', 'image']);
  });

  it('gobierno externo SOLO COSMÉTICO ⇒ salteada: el guard está inerte, no hay evidencia que refrescar', () => {
    // El hallazgo: bastaba con declarar CUALQUIER campo externo para que el scheduler paginara el
    // catálogo remoto dos veces por día, aunque el guard del bot no pudiera bloquear una sola venta
    // (exige un campo comercial). Las dos condiciones tienen que ser la MISMA.
    expect(catalogVerificationEligibility(cfg({ ownership: propiedadHibrida() }))).toEqual({
      can: 'skip',
      reason: 'no_external_governance',
    });
    // …y sin catalogId tampoco se BLOQUEA: no hay nada trabado que gritar (el guard no bloquea).
    expect(catalogVerificationEligibility(cfg({ ownership: propiedadHibrida(), catalogId: '' }))).toEqual({
      can: 'skip',
      reason: 'no_external_governance',
    });
  });

  it('sin NINGUNA config (credipower) ⇒ salteada, y se distingue de "config sin gobierno externo"', () => {
    // La distinción existe para que credipower no genere ni una lectura ni una escritura extra.
    expect(catalogVerificationEligibility(undefined)).toEqual({ can: 'skip', reason: 'no_catalog_sync' });
    expect(catalogVerificationEligibility(null)).toEqual({ can: 'skip', reason: 'no_catalog_sync' });
    expect(catalogVerificationEligibility('catalogSync')).toEqual({ can: 'skip', reason: 'no_catalog_sync' });
    expect(catalogVerificationEligibility([])).toEqual({ can: 'skip', reason: 'no_catalog_sync' });
  });

  it('config LEGACY (solo `sourceOfTruth`) con la sync apagada ⇒ salteada: el guard está inerte', () => {
    expect(catalogVerificationEligibility({ enabled: false, mode: 'off', catalogId: 'CAT-1', sourceOfTruth: 'vendeyapy' })).toEqual({
      can: 'skip',
      reason: 'no_external_governance',
    });
  });

  it('`vendeyapy_managed` con la sync apagada ⇒ salteada: nadie de afuera gobierna nada', () => {
    const e = catalogVerificationEligibility(
      cfg({ ownership: { model: 'vendeyapy_managed', ownedFields: ['price', 'title'], external: null } }),
    );
    expect(e).toEqual({ can: 'skip', reason: 'no_external_governance' });
  });

  it('gobierno externo SIN catalogId ⇒ BLOQUEADA (config contradictoria), nunca salteada', () => {
    for (const id of [undefined, '', '   ', 'cat/1', 'a'.repeat(65)]) {
      const e = catalogVerificationEligibility(cfg({ catalogId: id }));
      expect(e).toMatchObject({ can: 'blocked', reason: 'external_without_catalog' });
      if (e.can !== 'blocked') throw new Error('inalcanzable');
      // Viaja QUÉ campos quedan gobernados de afuera: es lo que el guard va a bloquear.
      expect(e.externalFields.length).toBeGreaterThan(0);
    }
  });

  it('INVARIANTE: se corre (o se grita) EXACTAMENTE cuando el guard del bot está activo', () => {
    // Es la regla del hallazgo escrita como propiedad, no como caso: cualquier config que le dé
    // munición al guard tiene que terminar en `run` (se refresca) o en `blocked` (se grita), pero
    // nunca en un `skip` silencioso — que es lo que apagaba la venta automática para siempre.
    //
    // CONTRATO CAMBIADO (hallazgo del review adversarial): "guard activo" NO es "hay campos
    // externos declarados". El guard se activa solo si la fuente externa gobierna un campo
    // COMERCIAL —es literalmente lo que evalúa `metaDriftProjection.activa` con `CAMPOS_CRITICOS`—.
    // Con la definición vieja, una declaración cosmética contaba como guard activo y obligaba a
    // paginar el catálogo remoto dos veces por día para refrescar evidencia que nadie mira.
    const configs: unknown[] = [
      cfg({ enabled: true, mode: 'dry_run' }),
      cfg({ enabled: true, mode: 'live' }),
      cfg({ enabled: false }),
      cfg({ enabled: true, mode: 'off' }),
      cfg({ catalogId: '' }),
      cfg({ enabled: false, ownership: propiedadHibrida() }),
      cfg({ enabled: false, ownership: propiedadHibrida(), catalogId: 'cat/1' }),
      cfg({ enabled: false, ownership: propiedadHibridaComercial() }),
      cfg({ enabled: false, ownership: propiedadHibridaComercial(), catalogId: 'cat/1' }),
      { enabled: false, mode: 'off', catalogId: 'CAT-1', sourceOfTruth: 'vendeyapy' },
      cfg({ ownership: { model: 'vendeyapy_managed', ownedFields: ['price'], external: null } }),
      undefined,
      {},
    ];
    for (const c of configs) {
      const guardActivo = declaredExternalFields(c).some((f) => (CAMPOS_CRITICOS as readonly string[]).includes(f));
      const e = catalogVerificationEligibility(c);
      if (guardActivo) expect(e.can, JSON.stringify(c)).not.toBe('skip');
      // Y al revés: con el guard inerte no se corre por las dudas ni se bloquea a nadie. La sync
      // ENCENDIDA es el otro camino y sigue corriendo por su cuenta (`via: 'sync_enabled'`).
      if (!guardActivo) {
        expect(e.can, JSON.stringify(c)).not.toBe('blocked');
        if (e.can === 'run') expect(e.via, JSON.stringify(c)).toBe('sync_enabled');
      }
    }
  });
});

describe('decideVerificationBlockedPatch — campana agregada e idempotente', () => {
  const T = 'arfagi';
  const now = Timestamp.fromMillis(1_700_000_000_000);
  const antes = Timestamp.fromMillis(1_600_000_000_000);

  it('sin aviso previo y sin bloqueo ⇒ null (jamás se crea un aviso vacío)', () => {
    expect(decideVerificationBlockedPatch(T, null, undefined, now)).toBeNull();
  });

  it('bloqueo nuevo ⇒ aviso abierto, no leído, con dedupeKey determinístico por tenant', () => {
    const p = decideVerificationBlockedPatch(T, 'external_without_catalog', undefined, now)!;
    expect(p.dedupeKey).toBe(catalogVerificationNotificationId(T));
    expect(p.category).toBe('catalog_verification');
    expect(p.read).toBe(false);
    expect(p.resolvedAt).toBeNull();
    expect(String(p.body)).toContain('quitá la declaración de fuente externa'); // la salida humana
  });

  it('el MISMO hallazgo sobre un aviso ya leído NO lo re-abre (no duplica alertas)', () => {
    const p = decideVerificationBlockedPatch(T, 'external_without_catalog', { createdAt: antes, resolvedAt: null, read: true }, now)!;
    expect(p).not.toHaveProperty('read');
    expect(p.createdAt).toBe(antes); // conserva el "desde cuándo"
  });

  it('un aviso YA CERRADO se REABRE si el bloqueo vuelve a aparecer', () => {
    const p = decideVerificationBlockedPatch(T, 'external_without_catalog', { createdAt: antes, resolvedAt: antes, read: true }, now)!;
    expect(p.read).toBe(false);
    expect(p.resolvedAt).toBeNull();
  });

  it('resuelto el bloqueo, el aviso abierto se AUTOCIERRA; uno ya cerrado no se re-escribe', () => {
    const cierre = decideVerificationBlockedPatch(T, null, { createdAt: antes, resolvedAt: null, read: false }, now)!;
    expect(cierre.resolvedAt).toBe(now);
    expect(cierre.read).toBe(true);
    expect(decideVerificationBlockedPatch(T, null, { createdAt: antes, resolvedAt: antes, read: true }, now)).toBeNull();
  });

  it('el aviso no lleva URLs, hosts ni tokens: solo el hecho y la salida', () => {
    // Lo que se le muestra a una persona sobre el feed es el HECHO, nunca su dirección: la URL
    // firmada del feed lleva query string y token, y este documento queda para siempre.
    const p = decideVerificationBlockedPatch(T, 'external_without_catalog', undefined, now)!;
    const s = JSON.stringify(p);
    expect(s).not.toMatch(/https?:\/\//i);
    expect(s).not.toMatch(/access_token|bearer\s|\?[a-z_]+=/i);
  });
});
