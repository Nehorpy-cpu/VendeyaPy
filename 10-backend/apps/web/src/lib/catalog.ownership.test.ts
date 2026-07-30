/**
 * catalog.ownership.test.ts — Normalizadores tolerantes de propiedad y deriva (ADR-0015).
 *
 * El backend del programa se implementa en paralelo: estos tests fijan QUÉ tolera el panel
 * (propiedad anidada o plana, las dos ortografías de cada lista, Timestamp serializado) y,
 * sobre todo, que ante cualquier duda el panel NO se atribuya permisos de escritura.
 */
import { describe, it, expect } from 'vitest';
import { aFecha, normalizarDerivaProducto, normalizarOwnershipStatus } from './catalog';

const FEED_ARFAGI = {
  kind: 'meta_feed',
  acknowledgedSourceIds: ['123456'],
  declaredFields: ['title', 'description', 'price', 'currency', 'availability', 'inventory', 'brand', 'image', 'url'],
  fingerprint: 'huella-saneada',
  acknowledgedByUid: 'uid-owner',
  name: 'Catálogo del sitio',
  schedule: { hour: 3, minute: 33, timezone: 'America/Asuncion' },
  deletionEnabled: true,
  itemCount: 181,
};

describe('normalizarOwnershipStatus — el caso arfagi', () => {
  it('external_managed con feed reconocido: cero campos propios, techo dry-run, fuente saneada', () => {
    const s = normalizarOwnershipStatus({
      enabled: true,
      configMode: 'dry_run',
      effectiveMode: 'dry_run',
      lastSourceCheckAt: { _seconds: 1785000000, _nanoseconds: 0 },
      ownership: {
        model: 'external_managed',
        writable: [],
        external: FEED_ARFAGI.declaredFields,
        externalSource: FEED_ARFAGI,
        modeCeiling: 'dry_run',
        degraded: false,
        reasons: [],
      },
    });
    expect(s.configurado).toBe(true);
    expect(s.model).toBe('external_managed');
    expect(s.propios).toEqual([]);
    expect(s.externos).toContain('price');
    expect(s.modoEfectivo).toBe('dry_run');
    expect(s.degradado).toBe(false);
    expect(s.fuentes).toHaveLength(1);
    expect(s.fuentes[0]!.reconocida).toBe(true);
    expect(s.fuentes[0]!.nombre).toBe('Catálogo del sitio');
    expect(s.fuentes[0]!.horario).toBe('todos los días a las 03:33 (America/Asuncion)');
    expect(s.fuentes[0]!.borraFaltantes).toBe(true);
    expect(s.fuentes[0]!.articulos).toBe(181);
    expect(s.sinReconocer).toBe(0);
    expect(s.verificadoEn).toBeInstanceOf(Date);
  });

  it('el nombre de la fuente llega saneado aunque el backend mande la URL firmada adentro', () => {
    const s = normalizarOwnershipStatus({
      enabled: true,
      configMode: 'dry_run',
      ownership: {
        model: 'external_managed',
        externalSource: {
          ...FEED_ARFAGI,
          name: 'Feed https://arfagi.com/feed.csv?access_token=EAAsecreto123',
        },
      },
    });
    const nombre = s.fuentes[0]!.nombre;
    expect(nombre).toBe('Feed');
    expect(nombre).not.toContain('http');
    expect(nombre).not.toContain('access_token');
    expect(JSON.stringify(s)).not.toContain('access_token');
  });
});

describe('normalizarOwnershipStatus — fail-closed en la presentación', () => {
  it('respuesta vacía: no configurado y sin campos propios (jamás se asume permiso)', () => {
    const s = normalizarOwnershipStatus({});
    expect(s.configurado).toBe(false);
    expect(s.propios).toEqual([]);
    expect(s.model).toBe('external_managed');
    expect(s.modoEfectivo).toBe('off');
  });

  it('documento legacy (solo sourceOfTruth): degradado, cero campos propios y modo efectivo dry-run', () => {
    const s = normalizarOwnershipStatus({
      enabled: true,
      configMode: 'live',
      ownership: { model: 'external_managed', degraded: true, reasons: ['ownership_missing'], modeCeiling: 'dry_run' },
    });
    expect(s.degradado).toBe(true);
    expect(s.motivos).toEqual(['ownership_missing']);
    expect(s.propios).toEqual([]);
    expect(s.modoConfigurado).toBe('live');
    expect(s.modoEfectivo).toBe('dry_run');
  });

  it('degradado con campos propios igual devuelve cero: la degradación manda', () => {
    const s = normalizarOwnershipStatus({
      enabled: true,
      configMode: 'live',
      ownership: { model: 'hybrid', writable: ['price'], degraded: true, reasons: ['ownership_conflict'] },
    });
    expect(s.propios).toEqual([]);
    expect(s.modoEfectivo).toBe('dry_run');
  });

  it('campos inventados o internos se descartan de las dos listas', () => {
    const s = normalizarOwnershipStatus({
      enabled: true,
      configMode: 'dry_run',
      ownership: {
        model: 'hybrid',
        ownedFields: ['price', 'cost', 'productFinancials', 'inventado'],
        externalFields: ['title', 'aiFicha'],
      },
    });
    expect(s.propios).toEqual(['price']);
    expect(s.externos).toEqual(['title']);
  });

  it('propiedad PLANA (sin anidar en `ownership`) también se entiende', () => {
    const s = normalizarOwnershipStatus({
      enabled: true,
      mode: 'live',
      model: 'vendeyapy_managed',
      ownedFields: ['title', 'price'],
      modeCeiling: 'live',
    });
    expect(s.model).toBe('vendeyapy_managed');
    expect(s.propios).toEqual(['title', 'price']);
    expect(s.modoEfectivo).toBe('live');
  });

  it('fuente detectada SIN reconocer se cuenta aparte (bloquea escrituras)', () => {
    const s = normalizarOwnershipStatus({
      enabled: true,
      configMode: 'dry_run',
      ownership: { model: 'external_managed' },
      detectedSources: [{ kind: 'meta_feed', id: 'ds-9', name: 'Feed nuevo', acknowledged: false }],
    });
    expect(s.fuentes).toHaveLength(1);
    expect(s.sinReconocer).toBe(1);
  });

  it('entiende la vista saneada del backend (MetaCatalogDetectedSource) tal cual llega', () => {
    // Shape de @vpw/shared: `sourceId`/`detectedFields`/`deletesMissingItems` y el horario
    // separado de su zona. Sin esta tolerancia la tarjeta mostraba la fuente sin campos, sin
    // horario y sin el aviso de borrado — justo lo que hace peligroso a un feed primario.
    const s = normalizarOwnershipStatus({
      enabled: true,
      configMode: 'dry_run',
      ownership: { model: 'external_managed' },
      detectedSources: [
        {
          kind: 'meta_feed',
          sourceId: '123456',
          name: 'Catálogo del sitio',
          host: 'arfagi.com',
          schedule: '03:33',
          timezone: 'America/Asuncion',
          deletesMissingItems: true,
          detectedFields: ['title', 'price', 'availability'],
          itemCount: 181,
          fingerprint: 'huella',
          lastSeenAtMs: 1785000000000,
        },
      ],
    });
    expect(s.fuentes).toHaveLength(1);
    const f = s.fuentes[0]!;
    expect(f.id).toBe('123456');
    expect(f.nombre).toBe('Catálogo del sitio');
    expect(f.horario).toBe('a las 03:33 (America/Asuncion)');
    expect(f.campos).toEqual(['title', 'price', 'availability']);
    expect(f.borraFaltantes).toBe(true);
    expect(f.articulos).toBe(181);
    // Nadie la reconoció: bloquea escrituras hasta que una persona la revise.
    expect(f.reconocida).toBe(false);
    expect(s.sinReconocer).toBe(1);
    // Y los campos externos se infieren de la fuente cuando la propiedad no los declara.
    expect(s.externos).toEqual(['title', 'price', 'availability']);
  });

  it('una fuente detectada cuyo id YA fue reconocido no se reporta como desconocida', () => {
    const s = normalizarOwnershipStatus({
      enabled: true,
      configMode: 'dry_run',
      ownership: {
        model: 'external_managed',
        externalSource: { ...FEED_ARFAGI, acknowledgedSourceIds: ['111', '222'] },
      },
      detectedSources: [
        { kind: 'meta_feed', sourceId: '222', name: 'Feed secundario', detectedFields: ['image'] },
        { kind: 'meta_feed', sourceId: '999', name: 'Feed desconocido', detectedFields: ['price'] },
      ],
    });
    // La reconocida principal (id 111) + la secundaria reconocida (222) + la desconocida (999).
    expect(s.fuentes.map((f) => f.reconocida)).toEqual([true, true, false]);
    expect(s.sinReconocer).toBe(1);
  });

  it('acepta la config anidada (config:{mode,enabled}) y la declaración externa como objeto', () => {
    const s = normalizarOwnershipStatus({
      ok: true,
      config: { mode: 'dry_run', enabled: true },
      ownership: { model: 'external_managed', ownedFields: [], external: FEED_ARFAGI },
    });
    expect(s.configurado).toBe(true);
    expect(s.modoConfigurado).toBe('dry_run');
    expect(s.propios).toEqual([]);
    expect(s.fuentes).toHaveLength(1);
    expect(s.fuentes[0]!.reconocida).toBe(true);
    expect(s.externos).toContain('price');
  });

  it('la fuente reconocida no se duplica con la detectada del mismo id', () => {
    const s = normalizarOwnershipStatus({
      enabled: true,
      configMode: 'dry_run',
      ownership: { model: 'external_managed', externalSource: { ...FEED_ARFAGI, id: 'ds-1' } },
      detectedSources: [{ kind: 'meta_feed', id: 'ds-1', name: 'Catálogo del sitio', acknowledged: true }],
    });
    expect(s.fuentes).toHaveLength(1);
  });
});

/**
 * ADR-0015 §8 — APAGAR LA SINCRONIZACIÓN NO APAGA LA HONESTIDAD (eje REALIDAD).
 * ============================================================================
 * El callable devuelve `ownership` con el gate de ejecución puesto (PERMISO) y `declared` sin
 * gate (REALIDAD). Con `enabled:false` la propiedad efectiva viaja DEGRADADA —correcto: no
 * escribimos nada— y la tarjeta, que solo miraba ese eje, terminaba diciendo "todavía nadie
 * declaró quién administra el catálogo" con un feed reconocido publicando todas las madrugadas.
 */
describe('normalizarOwnershipStatus — sync apagada con gobierno externo reconocido', () => {
  /** Lo que manda el backend con `enabled:false`: propiedad degradada + realidad declarada. */
  const APAGADO_CON_FEED = {
    ok: true,
    enabled: false,
    configMode: 'off',
    effectiveMode: 'off',
    ownership: {
      model: 'external_managed',
      writable: [],
      external: [],
      externalSource: null,
      modeCeiling: 'dry_run',
      degraded: true,
      reasons: ['ownership_missing'],
    },
    declared: {
      externalFields: ['title', 'description', 'price', 'currency', 'availability', 'inventory', 'brand', 'image', 'url'],
      externalSource: FEED_ARFAGI,
    },
    detectedSources: [],
  };

  it('el PERMISO sigue cerrado: cero campos propios y modo efectivo off', () => {
    const s = normalizarOwnershipStatus(APAGADO_CON_FEED);
    expect(s.propios).toEqual([]);
    expect(s.modoConfigurado).toBe('off');
    expect(s.modoEfectivo).toBe('off');
    expect(s.sincronizacionApagada).toBe(true);
  });

  it('la REALIDAD se reporta igual: el catálogo lo gobierna la fuente externa reconocida', () => {
    const s = normalizarOwnershipStatus(APAGADO_CON_FEED);
    expect(s.gobiernoExterno).toBe(true);
    // Y NO se cae en el vacío "esta empresa no tiene un catálogo de Meta conectado".
    expect(s.configurado).toBe(true);
    expect(s.externos).toContain('price');
    expect(s.fuentes).toHaveLength(1);
    expect(s.fuentes[0]!.reconocida).toBe(true);
    expect(s.fuentes[0]!.nombre).toBe('Catálogo del sitio');
    expect(s.sinReconocer).toBe(0);
  });

  it('sync apagada y NADIE declaró nada ⇒ sigue siendo "sin catálogo conectado" (no se inventa un dueño)', () => {
    const s = normalizarOwnershipStatus({ ok: true, enabled: false, configMode: 'off', declared: { externalFields: [], externalSource: null } });
    expect(s.gobiernoExterno).toBe(false);
    expect(s.configurado).toBe(false);
    expect(s.externos).toEqual([]);
    expect(s.sincronizacionApagada).toBe(true);
  });

  it('con la sync ENCENDIDA nada cambia: el eje realidad no pisa lo que ya reportaba el permiso', () => {
    const s = normalizarOwnershipStatus({
      enabled: true,
      configMode: 'dry_run',
      effectiveMode: 'dry_run',
      ownership: { model: 'external_managed', writable: [], external: FEED_ARFAGI.declaredFields, externalSource: FEED_ARFAGI, degraded: false, reasons: [] },
      declared: { externalFields: FEED_ARFAGI.declaredFields, externalSource: FEED_ARFAGI },
    });
    expect(s.sincronizacionApagada).toBe(false);
    expect(s.gobiernoExterno).toBe(true);
    expect(s.fuentes).toHaveLength(1); // la declaración no se duplica con el eje realidad
    expect(s.externos).toEqual(FEED_ARFAGI.declaredFields);
  });

  it('la fuente del eje realidad también llega saneada (nunca la URL firmada ni el token)', () => {
    const s = normalizarOwnershipStatus({
      ...APAGADO_CON_FEED,
      declared: {
        externalFields: ['price'],
        externalSource: { ...FEED_ARFAGI, name: 'Feed https://arfagi.com/feed.csv?access_token=EAAsecreto123' },
      },
    });
    expect(s.fuentes[0]!.nombre).toBe('Feed');
    expect(JSON.stringify(s)).not.toContain('access_token');
    expect(JSON.stringify(s)).not.toContain('EAAsecreto123');
  });
});

describe('aFecha', () => {
  it('acepta Timestamp serializado, ISO, milisegundos y Date', () => {
    expect(aFecha({ _seconds: 1785000000 })?.getTime()).toBe(1785000000000);
    expect(aFecha({ seconds: 1785000000 })?.getTime()).toBe(1785000000000);
    expect(aFecha('2026-07-30T10:00:00.000Z')?.toISOString()).toBe('2026-07-30T10:00:00.000Z');
    expect(aFecha(1785000000000)?.getTime()).toBe(1785000000000);
  });

  it('lo que no es fecha devuelve null (no se inventa una verificación)', () => {
    expect(aFecha(null)).toBeNull();
    expect(aFecha('cuando sea')).toBeNull();
    expect(aFecha({})).toBeNull();
  });
});

/** Ahora fijo para que la caducidad derivada no dependa del reloj del que corre los tests. */
const AHORA = 1785000000000;

describe('normalizarDerivaProducto — Odyssey', () => {
  it('forma CANÓNICA (fields = nombres, valores en observed): campo comercial y valores formateados', () => {
    const d = normalizarDerivaProducto(
      {
        id: 'odyssey',
        name: 'Armaf Odyssey Mega',
        metaSyncStatus: 'synced', // histórico mentiroso: el eje ACTUAL manda
        metaSyncState: 'drifted_external',
        metaVerifiedAt: { _seconds: AHORA / 1000 },
        metaDrift: {
          fields: ['price'],
          owner: 'external',
          severity: 'commercial',
          observed: [
            { field: 'price', owner: 'external', severity: 'commercial', local: '250000 PYG', remote: '130000 PYG' },
          ],
        },
      },
      AHORA,
    );
    expect(d).not.toBeNull();
    expect(d!.estado).toBe('drifted_external');
    expect(d!.critico).toBe(true);
    expect(d!.campos).toHaveLength(1);
    expect(d!.campos[0]).toMatchObject({
      campo: 'price',
      etiqueta: 'Precio',
      duenio: 'externa',
      critico: true,
      local: '₲ 250.000',
      publicado: '₲ 130.000',
    });
    expect(d!.verificadoEn).toBeInstanceOf(Date);
  });

  it('solo la firma (fields como nombres, sin observed): nombra los campos con el dueño de la raíz', () => {
    const d = normalizarDerivaProducto(
      { metaSyncState: 'drifted_external', metaDrift: { fields: ['price', 'title'], owner: 'external', severity: 'commercial' } },
      AHORA,
    );
    expect(d!.campos.map((c) => c.etiqueta)).toEqual(['Precio', 'Nombre']);
    expect(d!.campos.every((c) => c.duenio === 'externa')).toBe(true);
    expect(d!.campos[0]!.local).toBe('—');
  });

  it('la forma con objetos en `fields` (tolerancia) sigue entendiéndose', () => {
    const d = normalizarDerivaProducto(
      {
        metaSyncState: 'drifted_external',
        metaDrift: { fields: [{ field: 'price', owner: 'external', severity: 'commercial', local: 250000, remote: 130000 }] },
      },
      AHORA,
    );
    expect(d!.campos[0]).toMatchObject({ local: '₲ 250.000', publicado: '₲ 130.000', critico: true });
  });

  it('CADUCIDAD: un `verified` con la verificación vencida deja de afirmar que coincide', () => {
    const viejo = { metaSyncState: 'verified', metaVerifiedAt: { _seconds: (AHORA - 40 * 60 * 60 * 1000) / 1000 } };
    expect(normalizarDerivaProducto(viejo, AHORA)!.estado).toBe('stale');
    // Fresco sí puede decir que coincide.
    const fresco = { metaSyncState: 'verified', metaVerifiedAt: { _seconds: (AHORA - 60 * 1000) / 1000 } };
    expect(normalizarDerivaProducto(fresco, AHORA)!.estado).toBe('verified');
    // Y sin fecha de verificación tampoco se afirma nada.
    expect(normalizarDerivaProducto({ metaSyncState: 'verified' }, AHORA)!.estado).toBe('stale');
  });

  it('una deriva vieja NO se degrada a `stale`: esconder una divergencia detectada es peor', () => {
    const d = normalizarDerivaProducto(
      {
        metaSyncState: 'drifted_external',
        metaVerifiedAt: { _seconds: (AHORA - 40 * 60 * 60 * 1000) / 1000 },
        metaDrift: { fields: ['price'], owner: 'external', severity: 'commercial' },
      },
      AHORA,
    );
    expect(d!.estado).toBe('drifted_external');
  });

  it('sin estado ni deriva devuelve null: nunca se inventa un "coincide"', () => {
    expect(normalizarDerivaProducto({ id: 'p', name: 'X', metaSyncStatus: 'synced' })).toBeNull();
    expect(normalizarDerivaProducto(null)).toBeNull();
  });

  it('una diferencia solo cosmética no se marca como crítica', () => {
    const d = normalizarDerivaProducto({
      metaSyncState: 'drifted_external',
      metaDrift: { fields: [{ field: 'title', owner: 'external', local: 'Odyssey Mega', remote: 'ODYSSEY MEGA' }] },
    });
    expect(d!.critico).toBe(false);
  });

  it('acepta la ortografía alternativa (campos/localValue/remoteValue) e infiere el estado', () => {
    const d = normalizarDerivaProducto({
      metaDrift: {
        campos: [{ campo: 'availability', duenio: 'external', localValue: 'in stock', remoteValue: 'out of stock' }],
      },
    });
    expect(d!.estado).toBe('drifted_external');
    expect(d!.campos[0]!.local).toBe('con stock');
    expect(d!.campos[0]!.publicado).toBe('sin stock');
    expect(d!.critico).toBe(true);
  });

  it('la imagen divergente se resume al host: nunca se pinta un enlace firmado', () => {
    const d = normalizarDerivaProducto({
      metaSyncState: 'drifted_external',
      metaDrift: {
        fields: [
          {
            field: 'image',
            owner: 'external',
            local: 'https://arfagi.com/img/a.jpg',
            remote: 'https://scontent.xx.fbcdn.net/v/t45.png?_nc_cat=1&oh=TOKENSECRETO123&oe=1',
          },
        ],
      },
    });
    const fila = d!.campos[0]!;
    expect(fila.publicado).toBe('enlace de scontent.xx.fbcdn.net');
    expect(fila.publicado).not.toContain('TOKENSECRETO123');
    expect(JSON.stringify(d)).not.toContain('TOKENSECRETO123');
  });
});
