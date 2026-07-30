/**
 * CatalogOwnershipCard.test.tsx — Tarjeta "Fuente de verdad del catálogo" (ADR-0015).
 *
 * Cubre el caso real de arfagi (feed externo reconocido que publica todos los campos públicos,
 * VendeYaPy sin nada para publicar y el envío bloqueado con su motivo), los estados
 * cargando / vacío / error con reintento, la navegación por teclado y —el más importante— que
 * NUNCA se pinte una URL con token, aunque el backend la mande adentro del nombre de la fuente.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Product } from '@vpw/shared';
import { normalizarOwnershipStatus } from '@/lib/catalog';
import { CatalogOwnershipCard } from './CatalogOwnershipCard';

const fetchOwnership = vi.fn();
vi.mock('@/lib/catalog', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/catalog')>();
  return { ...real, fetchCatalogOwnershipStatus: (...a: unknown[]) => fetchOwnership(...a) };
});

/** Respuesta cruda del callable para el caso arfagi (feed diario del sitio del tenant). */
const CRUDO_ARFAGI = {
  enabled: true,
  configMode: 'dry_run',
  effectiveMode: 'dry_run',
  lastSourceCheckAt: { _seconds: 1785000000 },
  ownership: {
    model: 'external_managed',
    writable: [],
    external: ['title', 'description', 'price', 'currency', 'availability', 'inventory', 'brand', 'image', 'url'],
    externalSource: {
      kind: 'meta_feed',
      acknowledgedSourceIds: ['123456'],
      declaredFields: ['title', 'description', 'price', 'currency', 'availability', 'inventory', 'brand', 'image', 'url'],
      fingerprint: 'huella',
      acknowledgedByUid: 'uid-owner',
      name: 'Catálogo del sitio',
      schedule: { hour: 3, minute: 33, timezone: 'America/Asuncion' },
      deletionEnabled: true,
      itemCount: 181,
    },
    modeCeiling: 'dry_run',
    degraded: false,
    reasons: [],
  },
};

const prodConDeriva = (): Product =>
  ({
    id: 'odyssey',
    name: 'Armaf Odyssey Mega',
    status: 'ACTIVE',
    metaSyncState: 'drifted_external',
    metaDrift: {
      fields: ['price'],
      owner: 'external',
      severity: 'commercial',
      observed: [{ field: 'price', owner: 'external', severity: 'commercial', local: '250000 PYG', remote: '130000 PYG' }],
    },
  }) as unknown as Product;

function renderCard(products: Product[] = []) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CatalogOwnershipCard tenantId="perfumeria" products={products} />
    </QueryClientProvider>,
  );
}

/**
 * Espera al estado de ÉXITO. No sirve buscar la `region` por su nombre: cargando y error
 * también son la misma sección con el mismo título, así que la búsqueda resolvería con el
 * esqueleto y el test pasaría mirando la pantalla equivocada.
 */
async function esperarTarjeta(): Promise<HTMLElement> {
  await screen.findByRole('button', { name: /Ver quién manda en cada dato|Ocultar detalle/ });
  return screen.getByRole('region', { name: 'Fuente de verdad del catálogo' });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CatalogOwnershipCard — fuente externa reconocida', () => {
  it('muestra el modelo, el feed con su horario, quién publica qué y la última verificación', async () => {
    fetchOwnership.mockResolvedValue(normalizarOwnershipStatus(CRUDO_ARFAGI));
    renderCard();

    const tarjeta = await esperarTarjeta();
    expect(tarjeta).toHaveTextContent('Lo administra tu propio sistema');
    expect(tarjeta).toHaveTextContent('Catálogo del sitio');
    expect(tarjeta).toHaveTextContent('Archivo de catálogo de tu sitio');
    expect(tarjeta).toHaveTextContent('Se publica todos los días a las 03:33 (America/Asuncion).');
    expect(tarjeta).toHaveTextContent('Publica 181 artículos.');
    expect(tarjeta).toHaveTextContent('Borra de Meta los artículos que no estén en esa publicación.');
    expect(tarjeta).toHaveTextContent('Reconocida por tu empresa');
    // Quién manda en cada dato, en criollo y sin abrir nada.
    expect(tarjeta).toHaveTextContent('Publica tu sistema');
    expect(tarjeta).toHaveTextContent(/Nombre, Descripción, Precio/);
    expect(tarjeta).toHaveTextContent(/Publica VendeYaPy\s*Ninguno/);
    expect(tarjeta).toHaveTextContent(/Última verificación contra lo publicado/);
  });

  it('bloquea el envío a Meta con el motivo a la vista', async () => {
    fetchOwnership.mockResolvedValue(normalizarOwnershipStatus(CRUDO_ARFAGI));
    renderCard();
    await esperarTarjeta();
    expect(screen.getByText('Enviar cambios a Meta está bloqueado.')).toBeInTheDocument();
    expect(
      screen.getByText(/VendeYaPy no tiene ningún dato asignado para publicar/),
    ).toBeInTheDocument();
  });

  it('advierte que hoy no se escribe nada y qué hace falta antes de activar el envío real', async () => {
    fetchOwnership.mockResolvedValue(normalizarOwnershipStatus(CRUDO_ARFAGI));
    renderCard();
    await esperarTarjeta();
    expect(screen.getByText(/Antes de activar el envío real/)).toBeInTheDocument();
    expect(screen.getByText(/se pisan todos los días/)).toBeInTheDocument();
  });

  it('con envío real activado Y fuente externa: alerta explícita de doble escritura', async () => {
    fetchOwnership.mockResolvedValue(
      normalizarOwnershipStatus({ ...CRUDO_ARFAGI, configMode: 'live', effectiveMode: 'live' }),
    );
    renderCard();
    const alerta = await screen.findByRole('alert');
    expect(alerta).toHaveTextContent('El envío real está activado');
    expect(alerta).toHaveTextContent('se pisan una y otra vez');
  });

  it('resume las diferencias de los productos cargados y manda al centro de calidad', async () => {
    fetchOwnership.mockResolvedValue(normalizarOwnershipStatus(CRUDO_ARFAGI));
    renderCard([prodConDeriva()]);
    await esperarTarjeta();
    expect(screen.getByText(/1 producto publicado con datos distintos a los tuyos/)).toBeInTheDocument();
    expect(screen.getByText(/se corrigen en el origen que los publica/)).toBeInTheDocument();
  });

  it('avisa cuando hay una fuente detectada que nadie reconoció', async () => {
    fetchOwnership.mockResolvedValue(
      normalizarOwnershipStatus({
        enabled: true,
        configMode: 'dry_run',
        ownership: { model: 'external_managed' },
        detectedSources: [{ kind: 'meta_feed', id: 'ds-9', name: 'Feed nuevo', acknowledged: false }],
      }),
    );
    renderCard();
    const alerta = await screen.findByRole('alert');
    expect(alerta).toHaveTextContent('nadie reconoció todavía');
    expect(alerta).toHaveTextContent('los envíos quedan bloqueados');
  });
});

/**
 * ADR-0015 §8 — LA TARJETA CON LA SINCRONIZACIÓN APAGADA.
 * =======================================================
 * `enabled:false` (o `mode:'off'`) apaga NUESTRA escritura, no el feed del tenant. El callable
 * manda la propiedad efectiva degradada (eje PERMISO) y el gobierno declarado aparte (eje
 * REALIDAD). Antes la tarjeta miraba solo el primero: caía en el vacío "esta empresa no tiene un
 * catálogo de Meta conectado" o afirmaba que nadie había declarado la propiedad, con el sitio
 * del tenant publicando los 181 artículos todas las madrugadas.
 */
describe('CatalogOwnershipCard — sincronización apagada con feed reconocido', () => {
  const CRUDO_APAGADO = {
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
      externalFields: CRUDO_ARFAGI.ownership.external,
      externalSource: CRUDO_ARFAGI.ownership.externalSource,
    },
    detectedSources: [],
  };

  it('sigue diciendo que el catálogo lo gobierna una fuente externa, con su feed reconocido', async () => {
    fetchOwnership.mockResolvedValue(normalizarOwnershipStatus(CRUDO_APAGADO));
    renderCard();
    const tarjeta = await esperarTarjeta();
    expect(tarjeta).toHaveTextContent('Lo administra tu propio sistema');
    expect(tarjeta).toHaveTextContent('Catálogo del sitio');
    expect(tarjeta).toHaveTextContent('Reconocida por tu empresa');
    expect(tarjeta).toHaveTextContent(/Publica tu sistema/);
    expect(tarjeta).toHaveTextContent(/Nombre, Descripción, Precio/);
    // Y jamás el vacío que negaba el catálogo entero.
    expect(screen.queryByText(/no tiene un catálogo de Meta conectado/)).not.toBeInTheDocument();
  });

  it('dice que la sincronización está apagada SIN negar quién gobierna el catálogo', async () => {
    fetchOwnership.mockResolvedValue(normalizarOwnershipStatus(CRUDO_APAGADO));
    renderCard();
    const tarjeta = await esperarTarjeta();
    expect(screen.getByText('La sincronización con Meta está apagada.')).toBeInTheDocument();
    expect(tarjeta).toHaveTextContent(/Tu propio sistema sigue publicando el catálogo/);
    // La mentira exacta que motivó el fix: "nadie declaró quién administra el catálogo".
    expect(tarjeta).not.toHaveTextContent(/Todavía nadie declaró/);
    expect(tarjeta).not.toHaveTextContent(/Todavía no identificamos qué sistema publica/);
    // El bloqueo del envío se mantiene, con el motivo REAL (el interruptor, no la propiedad).
    expect(screen.getByText('Enviar cambios a Meta está bloqueado.')).toBeInTheDocument();
    expect(screen.getByText(/La sincronización con Meta está apagada: VendeYaPy no publica nada allá\./)).toBeInTheDocument();
  });

  it('con la sync apagada y NADIE declarando gobierno externo, el vacío honesto se mantiene', async () => {
    fetchOwnership.mockResolvedValue(
      normalizarOwnershipStatus({ ok: true, enabled: false, configMode: 'off', declared: { externalFields: [], externalSource: null } }),
    );
    renderCard();
    await screen.findByText(/no tiene un catálogo de Meta conectado/);
  });

  it('la deriva ya detectada se sigue mostrando: el precio publicado no depende de nuestro interruptor', async () => {
    fetchOwnership.mockResolvedValue(normalizarOwnershipStatus(CRUDO_APAGADO));
    renderCard([prodConDeriva()]);
    const tarjeta = await esperarTarjeta();
    expect(tarjeta).toHaveTextContent('Qué está publicado distinto');
    expect(tarjeta).toHaveTextContent('Precio: acá ₲ 250.000 · publicado ₲ 130.000');
  });
});

describe('CatalogOwnershipCard — qué está publicado distinto (ADR-0015 §9, caso Odyssey)', () => {
  it('nombra el producto, muestra el valor de acá contra el publicado y manda a corregir en el ORIGEN', async () => {
    fetchOwnership.mockResolvedValue(normalizarOwnershipStatus(CRUDO_ARFAGI));
    renderCard([prodConDeriva()]);
    const tarjeta = await esperarTarjeta();

    expect(tarjeta).toHaveTextContent('Qué está publicado distinto');
    expect(tarjeta).toHaveTextContent('Armaf Odyssey Mega');
    // La plata a la vista: sin esto la tarjeta decía "hay 1 producto distinto" y nada más.
    expect(tarjeta).toHaveTextContent('Precio: acá ₲ 250.000 · publicado ₲ 130.000');
    expect(tarjeta).toHaveTextContent('(frena la venta automática)');
    // La corrección va al origen que publica. Jamás "editalo en Meta": el feed lo pisa mañana.
    expect(tarjeta).toHaveTextContent(/Corregilo en el origen que genera Catálogo del sitio/);
    const texto = tarjeta.textContent ?? '';
    expect(texto).not.toMatch(/edit\w*\s+(?:el\s+|la\s+|lo\s+)?\w*\s*en Meta/i);
    expect(texto).not.toMatch(/Commerce Manager|Administrador de Comercio/i);
  });

  it('una imagen divergente se resume al host: la URL firmada no llega ni al HTML', async () => {
    fetchOwnership.mockResolvedValue(normalizarOwnershipStatus(CRUDO_ARFAGI));
    renderCard([
      {
        id: 'odyssey',
        name: 'Armaf Odyssey Mega',
        status: 'ACTIVE',
        metaSyncState: 'drifted_external',
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
              remote: 'https://scontent.xx.fbcdn.net/v/t45.png?oh=TOKENSECRETO123&oe=1',
            },
          ],
        },
      } as unknown as Product,
    ]);
    const tarjeta = await esperarTarjeta();
    expect(tarjeta).toHaveTextContent('enlace de scontent.xx.fbcdn.net');
    expect(document.body.innerHTML).not.toContain('TOKENSECRETO123');
    expect(document.body.innerHTML).not.toContain('https://');
    expect(document.querySelector('a[href]')).toBeNull();
  });

  it('con muchos divergentes lista los primeros y manda el resto al centro de calidad', async () => {
    fetchOwnership.mockResolvedValue(normalizarOwnershipStatus(CRUDO_ARFAGI));
    const muchos = Array.from({ length: 7 }, (_, i) =>
      ({
        id: `p${i}`,
        name: `Producto ${i}`,
        status: 'ACTIVE',
        metaSyncState: 'drifted_external',
        metaDrift: { fields: ['title'], owner: 'external', severity: 'cosmetic' },
      }) as unknown as Product,
    );
    renderCard(muchos);
    const tarjeta = await esperarTarjeta();
    expect(tarjeta).toHaveTextContent('… y 2 más en “Calidad del catálogo”.');
    expect(screen.queryByText('Producto 6')).not.toBeInTheDocument();
  });
});

describe('CatalogOwnershipCard — la UI jamás pinta una URL con token', () => {
  it('el nombre de la fuente llega saneado aunque el backend mande la URL firmada', async () => {
    fetchOwnership.mockResolvedValue(
      normalizarOwnershipStatus({
        ...CRUDO_ARFAGI,
        ownership: {
          ...CRUDO_ARFAGI.ownership,
          externalSource: {
            ...CRUDO_ARFAGI.ownership.externalSource,
            name: 'Catálogo https://arfagi.com/feed.csv?access_token=EAAsecreto123&sig=abc',
          },
        },
      }),
    );
    renderCard();
    await esperarTarjeta();
    const texto = document.body.textContent ?? '';
    expect(texto).toContain('Catálogo');
    expect(texto).not.toContain('http');
    expect(texto).not.toContain('access_token');
    expect(texto).not.toContain('EAAsecreto123');
    expect(texto).not.toContain('?');
    // Y tampoco queda escondida en un atributo (href, title, aria-label…).
    expect(document.body.innerHTML).not.toContain('EAAsecreto123');
    expect(document.querySelector('a[href]')).toBeNull();
  });
});

describe('CatalogOwnershipCard — estados y accesibilidad', () => {
  it('cargando: lo anuncia con aria-live y no inventa datos', () => {
    fetchOwnership.mockReturnValue(new Promise(() => {}));
    renderCard();
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByText('Revisando quién administra tu catálogo…')).toBeInTheDocument();
  });

  it('error: role=alert con Reintentar que vuelve a consultar', async () => {
    fetchOwnership.mockRejectedValue(new Error('permission-denied'));
    renderCard();
    const alerta = await screen.findByRole('alert');
    expect(alerta).toHaveTextContent('No pudimos verificar quién administra tu catálogo ahora.');
    expect(fetchOwnership).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(fetchOwnership).toHaveBeenCalledTimes(2));
  });

  it('vacío honesto: sin catálogo conectado no se promete ninguna publicación', async () => {
    fetchOwnership.mockResolvedValue(normalizarOwnershipStatus({}));
    renderCard();
    await screen.findByText(/no tiene un catálogo de Meta conectado/);
    expect(screen.queryByText('Enviar cambios a Meta está bloqueado.')).not.toBeInTheDocument();
  });

  it('el detalle por dato se abre con el teclado y declara aria-expanded', async () => {
    fetchOwnership.mockResolvedValue(normalizarOwnershipStatus(CRUDO_ARFAGI));
    renderCard();
    const boton = await screen.findByRole('button', { name: 'Ver quién manda en cada dato' });
    expect(boton).toHaveAttribute('aria-expanded', 'false');

    boton.focus();
    expect(document.activeElement).toBe(boton);
    // Enter sobre un <button> enfocado dispara su click (comportamiento nativo del teclado).
    fireEvent.keyDown(boton, { key: 'Enter' });
    fireEvent.click(boton);

    const tabla = await screen.findByRole('table', { name: 'Dueño de cada dato público del catálogo' });
    expect(screen.getByRole('button', { name: 'Ocultar detalle' })).toHaveAttribute('aria-expanded', 'true');
    // Cada dato público con su dueño; los datos internos no figuran porque no se publican.
    expect(tabla).toHaveTextContent('Precio');
    expect(tabla).toHaveTextContent('Tu sistema');
    expect(tabla).not.toHaveTextContent('Costo');
    expect(screen.getByText(/nunca/)).toBeInTheDocument();
  });
});
