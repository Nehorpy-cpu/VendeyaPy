'use client';

/**
 * CatalogOwnershipCard — "Fuente de verdad del catálogo" (ADR-0015).
 *
 * Responde en criollo la pregunta que el panel nunca respondía: QUIÉN publica cada dato del
 * catálogo. Muestra el modelo de propiedad del tenant, la fuente externa reconocida (nombre
 * SANEADO y horario — jamás su URL ni su token), qué datos gobierna cada sistema, cuándo fue
 * la última verificación contra lo publicado, QUÉ productos están publicados distinto (con sus
 * valores: el caso de arfagi es Odyssey a ₲130.000 publicado contra ₲250.000 de acá) y, si
 * VendeYaPy no gobierna ningún dato, el BLOQUEO de los envíos con su motivo.
 *
 * DOS EJES QUE NO SE MEZCLAN (ADR-0015 §8): lo que VendeYaPy PUEDE PUBLICAR (permiso: `propios`,
 * `modoEfectivo`) y QUIÉN GOBIERNA el catálogo allá afuera (realidad: `gobiernoExterno`). Apagar
 * nuestra sincronización cierra lo primero y no cambia nada de lo segundo — el feed del tenant
 * sigue publicando —, así que la tarjeta lo dice por separado. Mezclarlos hacía que apagar el
 * sync borrara de pantalla a un feed ya reconocido.
 *
 * Es SOLO LECTURA: no cambia el modelo, no reconoce fuentes y no escribe una coma en Meta.
 * Patrón visual de OutboxIncidents/CatalogQualityCenter: sección con aria-labelledby y estados
 * cargando / vacío / error (con reintento) / éxito.
 */

import { useId, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Product } from '@vpw/shared';
import {
  fetchCatalogOwnershipStatus,
  normalizarDerivaProducto,
  type CatalogOwnershipStatus,
  type ProductoDerivaView,
} from '@/lib/catalog';
import {
  CAMPOS_PUBLICOS,
  ESTADO_META_INFO,
  MODELO_EXPLICACION,
  MODELO_LABEL,
  etiquetaCampo,
  etiquetaMotivo,
  etiquetaTipoFuente,
} from '@/lib/catalogOwnership';
import { accionRecomendada } from '@/components/MetaDriftDetail';
import { StatusBadge } from '@/components/ui';

/** Cuántos productos divergentes se listan con nombre y valores antes de mandar al centro. */
const DIVERGENTES_VISIBLES = 5;

const fechaLegible = (d: Date | null): string =>
  d ? d.toLocaleString('es-PY', { dateStyle: 'short', timeStyle: 'short' }) : '';

/** Lista de datos en criollo ("Precio, Stock y Marca"). '' si no hay ninguno. */
function listaCampos(campos: readonly string[]): string {
  const nombres = campos.map(etiquetaCampo);
  if (nombres.length === 0) return '';
  if (nombres.length === 1) return nombres[0]!;
  return `${nombres.slice(0, -1).join(', ')} y ${nombres[nombres.length - 1]}`;
}

export function CatalogOwnershipCard({
  tenantId,
  products = [],
}: {
  tenantId: string;
  /** Productos ya cargados en la página: sirven para contar diferencias sin otra consulta. */
  products?: Product[];
}) {
  const uid = useId();
  const [abierto, setAbierto] = useState(false);

  const ownQ = useQuery({
    queryKey: ['catalogOwnership', tenantId],
    queryFn: () => fetchCatalogOwnershipStatus(tenantId),
    enabled: !!tenantId,
    retry: false,
  });

  const derivas = useMemo(() => {
    const divergentes: Array<{ id: string; nombre: string; deriva: ProductoDerivaView }> = [];
    let sinVerificar = 0;
    for (const p of products) {
      const d = normalizarDerivaProducto(p);
      if (!d) continue;
      // Mismos dos baldes que el centro de calidad: divergencia real contra "no lo pudimos
      // verificar". Mezclarlos haría que una verificación vencida se lea como un problema
      // publicado, y con un catálogo grande vencen casi todos a la vez.
      if (d.estado === 'drifted' || d.estado === 'drifted_external' || d.estado === 'remote_missing') {
        divergentes.push({ id: p.id, nombre: p.name, deriva: d });
      } else if (d.estado === 'unverifiable' || d.estado === 'stale') sinVerificar++;
    }
    // Los que frenan la venta automática (plata y disponibilidad) van primero: si hay que
    // recortar la lista, lo último que se puede esconder es el precio publicado distinto.
    divergentes.sort((a, b) => Number(b.deriva.critico) - Number(a.deriva.critico));
    return { divergentes, distintos: divergentes.length, sinVerificar };
  }, [products]);

  const titulo = (
    <h2 id={`${uid}-titulo`} className="text-sm font-semibold text-ink-900">
      Fuente de verdad del catálogo
    </h2>
  );

  // --- Cargando ---
  if (ownQ.isLoading) {
    return (
      <section aria-labelledby={`${uid}-titulo`} className="rounded-2xl border border-ink-100 bg-white p-4 shadow-soft">
        {titulo}
        <div role="status" aria-live="polite" className="mt-2">
          <span className="sr-only">Revisando quién administra tu catálogo…</span>
          <div className="h-6 w-2/3 animate-pulse rounded-lg bg-ink-50" />
        </div>
      </section>
    );
  }

  // --- Error con reintento ---
  if (ownQ.isError || !ownQ.data) {
    return (
      <section aria-labelledby={`${uid}-titulo`} className="rounded-2xl border border-ink-100 bg-white p-4 shadow-soft">
        {titulo}
        <div role="alert" className="mt-2 rounded-lg bg-coral-50 px-3 py-2 text-sm text-coral-700">
          <div className="flex flex-wrap items-center gap-3">
            <span>No pudimos verificar quién administra tu catálogo ahora.</span>
            <button
              onClick={() => ownQ.refetch()}
              className="rounded-lg border border-coral-200 bg-white px-2.5 py-1 text-xs font-semibold text-coral-700 transition-colors hover:bg-coral-50"
            >
              Reintentar
            </button>
          </div>
          {/* Fail-CLOSED explícito: sin saber quién manda no se habilita nada, y se dice acá
              para que el bloqueo de la grilla no parezca un error suelto. */}
          <p className="mt-1 text-xs">
            Hasta poder verificarlo, activar la sincronización de un producto y enviar cambios a Meta quedan bloqueados.
          </p>
        </div>
      </section>
    );
  }

  const own: CatalogOwnershipStatus = ownQ.data;

  // --- Vacío honesto: el tenant no tiene catálogo de Meta conectado ---
  if (!own.configurado) {
    return (
      <section aria-labelledby={`${uid}-titulo`} className="rounded-2xl border border-dashed border-ink-200 bg-white p-4">
        {titulo}
        <p className="mt-1 text-sm text-ink-600">
          Esta empresa no tiene un catálogo de Meta conectado: no se lee ni se publica nada allá. Tus productos viven
          solamente acá.
        </p>
      </section>
    );
  }

  const sinCamposPropios = own.propios.length === 0;
  const fuentePrincipal = own.fuentes[0] ?? null;

  return (
    <section aria-labelledby={`${uid}-titulo`} className="space-y-3 rounded-2xl border border-ink-100 bg-white p-4 shadow-soft">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {titulo}
            <StatusBadge tone={own.degradado ? 'amber' : own.model === 'vendeyapy_managed' ? 'mint' : 'ink'}>
              {MODELO_LABEL[own.model]}
            </StatusBadge>
          </div>
          {/* Con la sync apagada la explicación genérica del modelo ("lo lee, lo compara y te
              avisa") contradiría al aviso de abajo: hoy no leemos nada. Quién gobierna sí se
              mantiene, porque eso no depende de nuestro interruptor. */}
          <p className="mt-1 text-sm text-ink-600">
            {own.sincronizacionApagada && own.gobiernoExterno
              ? 'Tu sitio (o tu sistema de gestión) publica el catálogo en Meta. VendeYaPy no escribe ni compara nada allá mientras la sincronización esté apagada.'
              : MODELO_EXPLICACION[own.model]}
          </p>
        </div>
        <button
          onClick={() => setAbierto((v) => !v)}
          aria-expanded={abierto}
          className="rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50 focus:outline-none focus:ring-2 focus:ring-mint-500/40"
        >
          {abierto ? 'Ocultar detalle' : 'Ver quién manda en cada dato'}
        </button>
      </div>

      {/* Sincronización apagada: se dice ACÁ y por separado del gobierno del catálogo. El owner
          tiene que poder leer "nosotros no publicamos nada" sin que eso se confunda con "nadie
          publica nada": si hay una fuente reconocida, el catálogo lo sigue gobernando ella. */}
      {own.sincronizacionApagada && (
        <div role="status" className="rounded-xl border border-ink-200 bg-ink-50/60 px-3 py-2 text-sm text-ink-800">
          <p className="font-semibold">La sincronización con Meta está apagada.</p>
          <p className="mt-0.5">
            {own.gobiernoExterno
              ? 'VendeYaPy no publica ni compara nada allá. Tu propio sistema sigue publicando el catálogo: apagar esto no cambia quién manda en lo publicado.'
              : 'VendeYaPy no publica ni compara nada allá.'}
          </p>
        </div>
      )}

      {/* Fuente externa reconocida: nombre saneado + horario. NUNCA su enlace ni su token. */}
      {fuentePrincipal ? (
        <div className="rounded-xl border border-ink-100 bg-ink-50/40 p-3 text-sm">
          <p className="font-medium text-ink-900">
            {fuentePrincipal.nombre || etiquetaTipoFuente(fuentePrincipal.kind)}{' '}
            <span className="font-normal text-ink-600">— {etiquetaTipoFuente(fuentePrincipal.kind)}</span>
          </p>
          <ul className="mt-1 space-y-0.5 text-xs text-ink-600">
            {fuentePrincipal.horario && <li>Se publica {fuentePrincipal.horario}.</li>}
            {fuentePrincipal.articulos != null && <li>Publica {fuentePrincipal.articulos} artículos.</li>}
            {fuentePrincipal.borraFaltantes && (
              <li>Borra de Meta los artículos que no estén en esa publicación.</li>
            )}
            <li>
              {fuentePrincipal.reconocida
                ? 'Reconocida por tu empresa como la fuente que publica el catálogo.'
                : 'Todavía nadie la reconoció.'}
            </li>
          </ul>
        </div>
      ) : (
        own.model === 'external_managed' && (
          <p className="text-sm text-ink-600">Todavía no identificamos qué sistema publica tu catálogo.</p>
        )
      )}

      {/* Resumen de propiedad: quién publica qué (siempre visible, sin abrir nada). */}
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div className="rounded-xl border border-ink-100 p-3">
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">Publica tu sistema</dt>
          <dd className="mt-0.5 text-ink-800">
            {own.externos.length > 0
              ? listaCampos(own.externos)
              : own.model === 'external_managed'
                ? 'Todos los datos públicos del catálogo'
                : 'Ninguno'}
          </dd>
        </div>
        <div className="rounded-xl border border-ink-100 p-3">
          <dt className="text-xs font-medium uppercase tracking-wide text-ink-500">Publica VendeYaPy</dt>
          <dd className="mt-0.5 text-ink-800">{own.propios.length > 0 ? listaCampos(own.propios) : 'Ninguno'}</dd>
        </div>
      </dl>

      <p className="text-xs text-ink-500">
        {own.verificadoEn
          ? `Última verificación contra lo publicado: ${fechaLegible(own.verificadoEn)}.`
          : 'Todavía no comparamos tu catálogo con lo publicado.'}
      </p>

      {/* Bloqueo de escrituras, con el motivo a la vista (no en un tooltip). */}
      {sinCamposPropios && (
        <div role="status" className="rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2 text-sm text-amber-900">
          <p className="font-semibold">Enviar cambios a Meta está bloqueado.</p>
          <p className="mt-0.5">
            {/* El interruptor apagado es un motivo REAL y distinto de la propiedad sin declarar.
                Con la sync apagada el backend degrada la propiedad porque ni la mira, y mostrar
                acá "todavía nadie declaró quién publica cada dato" negaba un feed reconocido. */}
            {own.sincronizacionApagada
              ? 'La sincronización con Meta está apagada: VendeYaPy no publica nada allá.'
              : own.degradado
                ? own.motivos.length
                  ? etiquetaMotivo(own.motivos[0]!)
                  : etiquetaMotivo('ownership_missing')
                : 'VendeYaPy no tiene ningún dato asignado para publicar: todo lo público lo administra tu sistema.'}
          </p>
          {own.degradado && !own.sincronizacionApagada && (
            <p className="mt-0.5 text-xs">
              Hasta que se declare quién publica cada dato, se puede leer y comparar, pero no publicar.
            </p>
          )}
        </div>
      )}

      {/* Fuente detectada sin reconocer: bloquea escrituras hasta que una persona la revise. */}
      {own.sinReconocer > 0 && (
        <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50/60 px-3 py-2 text-sm text-amber-900">
          Detectamos {own.sinReconocer} {own.sinReconocer === 1 ? 'fuente que publica' : 'fuentes que publican'} tu
          catálogo y que nadie reconoció todavía. Hasta revisarla{own.sinReconocer === 1 ? '' : 's'}, los envíos quedan
          bloqueados.
        </div>
      )}

      {/* Advertencia de modo. El envío real con una fuente externa activa es un loop diario. */}
      {own.modoConfigurado === 'live' && own.externos.length > 0 ? (
        <div role="alert" className="rounded-xl border border-coral-200 bg-coral-50 px-3 py-2 text-sm text-coral-800">
          El envío real está activado y además tu sistema publica el catálogo por su cuenta. Si los dos escriben el
          mismo dato, se pisan una y otra vez. Dejá un solo dueño por dato antes de seguir.
        </div>
      ) : (
        // Con la sync apagada el aviso de "modo de prueba" sobra y confunde: ya se dijo arriba,
        // con su nombre, que no publicamos nada.
        !own.sincronizacionApagada &&
        own.modoEfectivo !== 'live' && (
          <p className="text-xs text-ink-500">
            Hoy VendeYaPy <strong>no escribe nada</strong> en Meta (modo de prueba). Antes de activar el envío real hay
            que definir qué datos publica cada sistema: si los dos publican el mismo dato, se pisan todos los días.
          </p>
        )
      )}

      {(derivas.distintos > 0 || derivas.sinVerificar > 0) && (
        <p className="text-sm text-ink-700">
          {derivas.distintos > 0 && (
            <>
              <strong>
                {derivas.distintos} producto{derivas.distintos === 1 ? '' : 's'} publicado
                {derivas.distintos === 1 ? '' : 's'} con datos distintos a los tuyos
              </strong>
              {own.model === 'external_managed' ? ' — se corrigen en el origen que los publica.' : '.'}{' '}
            </>
          )}
          {derivas.sinVerificar > 0 && (
            <>
              {derivas.sinVerificar} sin poder verificar contra lo publicado.{' '}
            </>
          )}
          {derivas.divergentes.length > 0
            ? 'El detalle está acá abajo y en “Calidad del catálogo”.'
            : 'Están detallados en “Calidad del catálogo”.'}
        </p>
      )}

      {/* Qué está publicado distinto, con nombre y valores. Sin esto, la tarjeta decía "hay 1
          producto distinto" y el dueño tenía que salir a buscar cuál: el caso de arfagi es UN
          producto (Odyssey) con el precio publicado a ₲130.000 contra ₲250.000 de acá, y esa
          plata tiene que estar a la vista. La acción es la MISMA que muestra la grilla: se
          corrige en el origen que publica — jamás editando el catálogo de Meta a mano. */}
      {derivas.divergentes.length > 0 && (
        <div className="rounded-xl border border-coral-200 bg-coral-50/40 p-3">
          <h3 className="text-sm font-semibold text-ink-900">Qué está publicado distinto</h3>
          <ul className="mt-1.5 space-y-2">
            {derivas.divergentes.slice(0, DIVERGENTES_VISIBLES).map(({ id, nombre, deriva }) => (
              <li key={id}>
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink-900">
                  {nombre}
                  <StatusBadge tone={ESTADO_META_INFO[deriva.estado].tono}>
                    {ESTADO_META_INFO[deriva.estado].label}
                  </StatusBadge>
                </p>
                {deriva.campos.length > 0 && (
                  <ul className="mt-0.5 space-y-0.5 text-xs text-ink-700">
                    {deriva.campos.map((c) => (
                      <li key={c.campo}>
                        <span className="font-medium">{c.etiqueta}:</span> acá {c.local} · publicado{' '}
                        <span className="font-semibold text-coral-700">{c.publicado}</span>
                        {c.critico && <span className="ml-1 text-coral-700"> (frena la venta automática)</span>}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-0.5 text-xs text-ink-700">
                  <span className="font-semibold">Qué hacer:</span>{' '}
                  {accionRecomendada(deriva, fuentePrincipal?.nombre ?? '')}
                </p>
              </li>
            ))}
          </ul>
          {derivas.divergentes.length > DIVERGENTES_VISIBLES && (
            <p className="mt-1.5 text-xs text-ink-600">
              … y {derivas.divergentes.length - DIVERGENTES_VISIBLES} más en “Calidad del catálogo”.
            </p>
          )}
        </div>
      )}

      {abierto && (
        <div className="overflow-x-auto rounded-xl border border-ink-100">
          <table className="min-w-full text-left text-sm">
            <caption className="sr-only">Dueño de cada dato público del catálogo</caption>
            <thead className="border-b border-ink-100 bg-ink-50/60 text-xs uppercase tracking-wide text-ink-500">
              <tr>
                <th scope="col" className="px-3 py-2">Dato</th>
                <th scope="col" className="px-3 py-2">Lo publica</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-50">
              {CAMPOS_PUBLICOS.map((campo) => {
                const mio = own.propios.includes(campo);
                const suyo = own.externos.includes(campo) || (own.model === 'external_managed' && !mio);
                return (
                  <tr key={campo}>
                    <th scope="row" className="px-3 py-1.5 font-medium text-ink-800">{etiquetaCampo(campo)}</th>
                    <td className="px-3 py-1.5">
                      {mio ? (
                        <StatusBadge tone="mint">VendeYaPy</StatusBadge>
                      ) : suyo ? (
                        <StatusBadge tone="ink">Tu sistema</StatusBadge>
                      ) : (
                        <span className="text-xs text-ink-500">Sin dueño declarado (no se publica)</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="border-t border-ink-100 bg-white px-3 py-2 text-xs text-ink-500">
            El costo, el margen y tus notas internas <strong>nunca</strong> se publican ni se delegan: no aparecen en
            esta lista porque no salen de acá.
          </p>
        </div>
      )}
    </section>
  );
}
