/**
 * ProductMetaCell.test.tsx — Columna "Meta" de la grilla (ADR-0015).
 *
 * Fija las honestidades que faltaban:
 * 1. el estado verificado contra lo publicado le GANA al `metaSyncStatus:'synced'` histórico
 *    (Odyssey estaba en verde con el precio publicado un 92 % abajo);
 * 2. sin verificación real y fresca NO hay verde: "Sin verificar" / "Verificación vencida";
 * 3. los productos gobernados por una fuente externa se ven como tales;
 * 4. sin campos propios —o sin poder LEER quién los gobierna— el opt-in queda BLOQUEADO y con
 *    el motivo a la vista, y la acción recomendada jamás propone tocar el catálogo de Meta.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Product } from '@vpw/shared';
import { normalizarOwnershipStatus, type CatalogOwnershipStatus } from '@/lib/catalog';
import { ProductMetaCell } from './ProductMetaCell';

const OWN_EXTERNO: CatalogOwnershipStatus = normalizarOwnershipStatus({
  enabled: true,
  configMode: 'dry_run',
  ownership: {
    model: 'external_managed',
    writable: [],
    external: ['title', 'price', 'availability'],
    externalSource: {
      kind: 'meta_feed',
      acknowledgedSourceIds: ['1'],
      declaredFields: ['title', 'price', 'availability'],
      fingerprint: 'h',
      acknowledgedByUid: 'u',
      name: 'Catálogo del sitio',
    },
    modeCeiling: 'dry_run',
    degraded: false,
    reasons: [],
  },
});

const OWN_PROPIO: CatalogOwnershipStatus = normalizarOwnershipStatus({
  enabled: true,
  configMode: 'live',
  ownership: { model: 'vendeyapy_managed', writable: ['title', 'price'], modeCeiling: 'live', degraded: false, reasons: [] },
});

const OWN_DEGRADADO: CatalogOwnershipStatus = normalizarOwnershipStatus({
  enabled: true,
  configMode: 'live',
  ownership: { model: 'external_managed', degraded: true, reasons: ['ownership_missing'], modeCeiling: 'dry_run' },
});

const odyssey = (over: Partial<Product> = {}): Product =>
  ({
    id: 'odyssey',
    name: 'Armaf Odyssey Mega',
    status: 'ACTIVE',
    syncToMeta: true,
    metaSyncStatus: 'synced',
    metaRetailerId: 'ARF-ODY-1',
    metaSyncState: 'drifted_external',
    // Forma canónica de @vpw/shared: `fields` son NOMBRES y los valores saneados van en
    // `observed`. `commercial` = plata: frena la venta automática.
    metaDrift: {
      fields: ['price'],
      owner: 'external',
      severity: 'commercial',
      observed: [{ field: 'price', owner: 'external', severity: 'commercial', local: '250000 PYG', remote: '130000 PYG' }],
    },
    ...over,
  }) as unknown as Product;

function renderCell(
  product: Product,
  ownership: CatalogOwnershipStatus | null = OWN_EXTERNO,
  opts?: { cargando?: boolean },
) {
  const onHabilitar = vi.fn();
  const onDeshabilitar = vi.fn();
  const utils = render(
    <ProductMetaCell
      product={product}
      ownership={ownership}
      ownershipCargando={opts?.cargando ?? false}
      puedeReconciliar
      ocupado={false}
      onHabilitar={onHabilitar}
      onDeshabilitar={onDeshabilitar}
    />,
  );
  return { ...utils, onHabilitar, onDeshabilitar };
}

/** Segundos desde epoch, como serializa un Timestamp el callable. */
const hace = (ms: number) => ({ _seconds: (Date.now() - ms) / 1000 });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ProductMetaCell — deriva contra lo publicado', () => {
  it('drifted_external le gana a "Confirmado" y marca el producto como administrado afuera', () => {
    renderCell(odyssey());
    expect(screen.getByText('Publicado distinto por tu sistema')).toBeInTheDocument();
    expect(screen.queryByText('Confirmado')).not.toBeInTheDocument();
    expect(screen.getByText('Administrado por fuente externa')).toBeInTheDocument();
    expect(screen.getByText('↔ ARF-ODY-1')).toBeInTheDocument();
  });

  it('el detalle muestra el valor de acá y el publicado, y avisa que el bot no cierra la venta', () => {
    renderCell(odyssey());
    const ver = screen.getByRole('button', { name: /Ver la diferencia/ });
    expect(ver).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(ver);

    const tabla = screen.getByRole('table', { name: 'Diferencias entre tus datos y lo publicado' });
    expect(tabla).toHaveTextContent('Precio');
    expect(tabla).toHaveTextContent('₲ 250.000');
    expect(tabla).toHaveTextContent('₲ 130.000');
    expect(screen.getByText(/no cierra la venta solo/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Ocultar diferencia/ })).toHaveAttribute('aria-expanded', 'true');
  });

  it('el detalle se abre con el teclado y declara aria-expanded/aria-controls', () => {
    renderCell(odyssey());
    const ver = screen.getByRole('button', { name: /Ver la diferencia/ });
    ver.focus();
    expect(document.activeElement).toBe(ver);
    expect(ver).toHaveAttribute('aria-controls');
    // Enter sobre un <button> enfocado dispara su click (comportamiento nativo del teclado).
    fireEvent.keyDown(ver, { key: 'Enter' });
    fireEvent.click(ver);
    const detalle = document.getElementById(ver.getAttribute('aria-controls')!);
    expect(detalle).not.toBeNull();
    expect(screen.getByRole('button', { name: /Ocultar diferencia/ })).toHaveAttribute('aria-expanded', 'true');
  });

  it('la acción recomendada manda a corregir EN EL ORIGEN y nunca a editar el catálogo de Meta', () => {
    renderCell(odyssey());
    fireEvent.click(screen.getByRole('button', { name: /Ver la diferencia/ }));

    expect(screen.getByText(/Corregilo en el origen que genera Catálogo del sitio/)).toBeInTheDocument();
    const texto = document.body.textContent ?? '';
    // Ninguna variante de "editá/corregí/actualizá … en Meta", ni el Administrador de Comercio.
    expect(texto).not.toMatch(/edit\w*\s+(?:el\s+|la\s+|lo\s+)?\w*\s*en Meta/i);
    expect(texto).not.toMatch(/(corregí|corregi|actualizá|actualiza|cambiá|cambia)\w*\s+(?:el\s+|la\s+)?\w*\s*en Meta/i);
    expect(texto).not.toMatch(/Commerce Manager|Administrador de Comercio/i);
    expect(document.querySelector('a[href]')).toBeNull();
  });

  it('una imagen divergente se resume al host: nunca se pinta un enlace firmado', () => {
    renderCell(
      odyssey({
        metaDrift: {
          fields: ['image'],
          owner: 'external',
          severity: 'cosmetic',
          observed: [
            {
              field: 'image',
              owner: 'external',
              severity: 'cosmetic',
              local: 'https://arfagi.com/img/a.jpg',
              // Aunque el backend fallara y guardara la URL firmada, el panel no la pinta.
              remote: 'https://scontent.xx.fbcdn.net/v/t45.png?oh=TOKENSECRETO123&oe=1',
            },
          ],
        },
      } as unknown as Partial<Product>),
    );
    fireEvent.click(screen.getByRole('button', { name: /Ver la diferencia/ }));
    expect(screen.getByText('enlace de scontent.xx.fbcdn.net')).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('TOKENSECRETO123');
    expect(document.body.innerHTML).not.toContain('https://');
  });

  /**
   * CONTRATO CAMBIADO (ADR-0015 §5). Este test fijaba antes que un producto SIN verificación
   * mostrara el badge verde "Confirmado" (ayuda: "Meta confirmó que el artículo quedó igual que
   * acá"). Era falso para todos los productos de hoy: nadie leyó nunca el catálogo publicado.
   * `metaSyncStatus:'synced'` sigue siendo evidencia histórica de que Meta aceptó NUESTRO envío
   * —el eje histórico no se toca—, pero no dice nada de lo que Meta muestra ahora. El verde solo
   * lo enciende una lectura remota real y fresca.
   */
  it('sin verificación NO hay verde: "Confirmado" pasa a "Sin verificar" con su explicación', () => {
    renderCell(odyssey({ metaSyncState: undefined, metaDrift: undefined } as unknown as Partial<Product>));
    expect(screen.getByText('Sin verificar')).toBeInTheDocument();
    expect(screen.queryByText('Confirmado')).not.toBeInTheDocument();
    expect(screen.getByText(/todavía no leímos el catálogo publicado/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Ver la diferencia/ })).not.toBeInTheDocument();
  });

  it('una verificación REAL y FRESCA sí puede decir que coincide', () => {
    renderCell(
      odyssey({
        metaSyncState: 'verified',
        metaVerifiedAt: hace(60 * 1000),
        metaDrift: null,
      } as unknown as Partial<Product>),
    );
    expect(screen.getByText('Coincide con lo publicado')).toBeInTheDocument();
    expect(screen.queryByText('Sin verificar')).not.toBeInTheDocument();
  });

  it('la misma verificación VENCIDA (TTL 24 h) deja de afirmar que coincide', () => {
    renderCell(
      odyssey({
        metaSyncState: 'verified',
        metaVerifiedAt: hace(40 * 60 * 60 * 1000),
        metaDrift: null,
      } as unknown as Partial<Product>),
    );
    expect(screen.getByText('Verificación vencida')).toBeInTheDocument();
    expect(screen.queryByText('Coincide con lo publicado')).not.toBeInTheDocument();
    expect(screen.getByText(/no damos por confirmado el precio ni el stock/)).toBeInTheDocument();
  });

  it('un producto sin opt-in no afirma nada, aunque arrastre un `synced` histórico', () => {
    renderCell(
      odyssey({
        syncToMeta: false,
        metaSyncState: undefined,
        metaDrift: undefined,
      } as unknown as Partial<Product>),
    );
    expect(screen.getByText('No se sincroniza')).toBeInTheDocument();
    expect(screen.queryByText('Confirmado')).not.toBeInTheDocument();
  });

  it('un envío en cola sigue mostrándose tal cual: no afirma que Meta esté igual que acá', () => {
    renderCell(
      odyssey({
        metaSyncStatus: 'queued',
        metaSyncState: undefined,
        metaDrift: undefined,
      } as unknown as Partial<Product>),
    );
    expect(screen.getByText('En cola')).toBeInTheDocument();
    expect(screen.queryByText('Coincide con lo publicado')).not.toBeInTheDocument();
  });
});

describe('ProductMetaCell — bloqueo del opt-in sin campos propios', () => {
  const sinSync = () =>
    ({ id: 'p1', name: 'Producto 1', status: 'ACTIVE', metaRetailerId: 'R-1' }) as unknown as Product;

  it('con el catálogo gobernado afuera el botón queda inerte y el motivo se lee al lado', () => {
    const { onHabilitar } = renderCell(sinSync(), OWN_EXTERNO);
    const boton = screen.getByRole('button', { name: 'Sincronizar con Meta…' });
    expect(boton).toBeDisabled();
    fireEvent.click(boton);
    expect(onHabilitar).not.toHaveBeenCalled();

    // El motivo es texto visible (no un tooltip) y está asociado al botón por aria-describedby.
    const motivo = screen.getByText(/Tu propio sistema administra los datos publicados/);
    expect(motivo).toBeInTheDocument();
    expect(boton).toHaveAttribute('aria-describedby', motivo.id);
  });

  it('con la propiedad sin declarar (documento legacy) también bloquea, con su propio motivo', () => {
    renderCell(sinSync(), OWN_DEGRADADO);
    expect(screen.getByRole('button', { name: 'Sincronizar con Meta…' })).toBeDisabled();
    expect(screen.getByText(/nadie declaró qué datos publica VendeYaPy/)).toBeInTheDocument();
  });

  it('con campos propios el opt-in funciona y se puede usar con el teclado', () => {
    const { onHabilitar } = renderCell(sinSync(), OWN_PROPIO);
    const boton = screen.getByRole('button', { name: 'Sincronizar con Meta…' });
    expect(boton).toBeEnabled();
    boton.focus();
    expect(document.activeElement).toBe(boton);
    fireEvent.click(boton);
    expect(onHabilitar).toHaveBeenCalledTimes(1);
    // Y no se lo marca como administrado afuera: acá manda VendeYaPy.
    expect(screen.queryByText('Administrado por fuente externa')).not.toBeInTheDocument();
  });

  /**
   * CONTRATO CAMBIADO (ADR-0015 §2 y §7). Antes este test fijaba lo contrario: con la propiedad
   * desconocida el opt-in quedaba HABILITADO ("el gate real vive en el backend"). Eso es
   * fail-OPEN, y como la tarjeta de propiedad fallaba siempre, era el estado real del panel:
   * ofrecía publicar en un catálogo que gobierna un feed externo. Si no sabemos quién manda,
   * asumimos que no somos nosotros y lo decimos.
   */
  it('FAIL-CLOSED: si no se pudo leer la propiedad el opt-in queda bloqueado, no habilitado', () => {
    const { onHabilitar } = renderCell(sinSync(), null);
    const boton = screen.getByRole('button', { name: 'Sincronizar con Meta…' });
    expect(boton).toBeDisabled();
    fireEvent.click(boton);
    expect(onHabilitar).not.toHaveBeenCalled();

    const motivo = screen.getByText(/No pudimos verificar quién administra el catálogo/);
    expect(boton).toHaveAttribute('aria-describedby', motivo.id);
    // Y tampoco se inventa que lo administre otro sistema: eso también sería afirmar algo.
    expect(screen.queryByText('Administrado por fuente externa')).not.toBeInTheDocument();
  });

  it('mientras la propiedad se está leyendo el bloqueo lo dice así, no como una falla', () => {
    const { onHabilitar } = renderCell(sinSync(), null, { cargando: true });
    const boton = screen.getByRole('button', { name: 'Sincronizar con Meta…' });
    expect(boton).toBeDisabled();
    fireEvent.click(boton);
    expect(onHabilitar).not.toHaveBeenCalled();
    expect(screen.getByText(/Estamos verificando quién administra el catálogo/)).toBeInTheDocument();
  });

  it('el que ya sincroniza puede apagarse (esa acción no depende de la propiedad)', () => {
    const { onDeshabilitar } = renderCell(
      odyssey({ metaSyncState: undefined, metaDrift: undefined } as unknown as Partial<Product>),
      OWN_EXTERNO,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dejar de sincronizar' }));
    expect(onDeshabilitar).toHaveBeenCalledTimes(1);
  });
});
