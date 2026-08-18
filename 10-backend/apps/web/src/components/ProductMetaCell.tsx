'use client';

/**
 * ProductMetaCell — Columna "Meta" de la grilla del catálogo (ADR-0015).
 *
 * Muestra el estado ACTUAL del artículo publicado (no el histórico de la última escritura),
 * si ese producto lo administra una fuente externa, el detalle de las diferencias con sus
 * valores, y el opt-in de sincronización — BLOQUEADO Y CON MOTIVO A LA VISTA cuando VendeYaPy
 * no gobierna ningún dato publicable (con `external_managed` no existe patch posible).
 *
 * Por qué el estado de deriva le gana al estado operativo: `metaSyncStatus:'synced'` es una
 * afirmación sobre el pasado que nada caduca. Odyssey estuvo en verde con el precio publicado
 * un 92 % abajo. Si la verificación contra el catálogo publicado dice que hay diferencia, eso
 * es lo que ve el vendedor.
 *
 * Y si NO hay verificación, tampoco hay verde: un producto sin `metaVerifiedAt` —hoy, todos—
 * decía "Confirmado: Meta confirmó que el artículo quedó igual que acá" sin que nadie hubiera
 * leído jamás el catálogo publicado. Ahora dice "Sin verificar" con su explicación.
 *
 * FAIL-CLOSED: si no se puede leer quién administra el catálogo (`ownership === null`), el
 * opt-in queda BLOQUEADO con el motivo a la vista. Antes quedaba habilitado, que es lo peor de
 * los dos mundos: la tarjeta de propiedad fallaba y la grilla ofrecía publicar igual.
 */

import { useId, useMemo, useState } from 'react';
import type { Product } from '@vpw/shared';
import { normalizarDerivaProducto, type CatalogOwnershipStatus, type ProductoDerivaView } from '@/lib/catalog';
import { motivoBloqueoPorRelacion, nombreFuentePublicadora } from '@/lib/catalogAuthority';
import { ESTADO_META_INFO, ESTADO_SIN_VERIFICAR, etiquetaMotivo } from '@/lib/catalogOwnership';
import { MetaDriftDetail } from '@/components/MetaDriftDetail';
import { StatusBadge } from '@/components/ui';

interface BadgeMeta {
  label: string;
  tono: 'mint' | 'amber' | 'coral' | 'ink';
  ayuda: string;
}

/**
 * Estado OPERATIVO del envío (outbox): qué pasó con NUESTROS jobs. Es evidencia histórica, no
 * una afirmación sobre lo que Meta muestra hoy — por eso `synced` ya no tiene entrada acá:
 * lo resuelve `badgeMetaDe`, que exige verificación real antes de pintar cualquier verde.
 */
const SYNC_BADGE: Record<string, BadgeMeta> = {
  queued: { label: 'En cola', tono: 'amber', ayuda: 'El cambio está esperando su turno para enviarse a Meta.' },
  processing: { label: 'Procesando', tono: 'amber', ayuda: 'Lo estamos enviando a Meta. Falta la confirmación.' },
  pending: { label: 'Procesando', tono: 'amber', ayuda: 'Lo estamos enviando a Meta. Falta la confirmación.' },
  disabled: { label: 'Oculto en Meta', tono: 'ink', ayuda: 'El artículo quedó sin stock en el catálogo de Meta.' },
  needs_review: { label: 'Requiere revisión', tono: 'amber', ayuda: 'No se pudo confirmar solo: revisá el producto antes de reintentar.' },
  failed: { label: 'Error', tono: 'coral', ayuda: 'Meta rechazó el cambio.' },
};

/**
 * Badge del artículo contra el catálogo PUBLICADO. Regla dura (ADR-0015 §5): el verde
 * ("Coincide con lo publicado") solo lo enciende una verificación remota REAL y FRESCA. Sin
 * `metaVerifiedAt`, o con la verificación vencida, el badge dice la verdad: "Sin verificar" /
 * "Verificación vencida". El eje histórico (`metaSyncStatus`) sigue mostrándose cuando aporta
 * —en cola, procesando, error— porque ninguno de esos estados afirma que Meta esté igual que acá.
 *
 * PURA (sin hooks) para poder testear la regla sin montar la grilla entera.
 */
export function badgeMetaDe(product: Product, deriva: ProductoDerivaView | null): BadgeMeta {
  // 1) Verificación contra lo publicado: es el único eje que puede decir "coincide".
  //    `normalizarDerivaProducto` ya degradó un `verified` vencido a `stale` por TTL.
  if (deriva && deriva.estado !== 'desconocido') return ESTADO_META_INFO[deriva.estado];
  // 2) Sin opt-in no hay nada que afirmar sobre este producto (se mantiene como estaba).
  if (product.syncToMeta !== true) return { label: 'No se sincroniza', tono: 'ink', ayuda: '' };
  // 3) "Meta aceptó el envío" NO es "Meta muestra esto hoy": sin lectura remota no hay verde.
  if (product.metaSyncStatus === 'synced') return ESTADO_SIN_VERIFICAR;
  const operativo = product.metaSyncStatus ? SYNC_BADGE[product.metaSyncStatus] : undefined;
  if (operativo) return operativo;
  // 4) Habilitado y sin ningún envío todavía: tampoco es verde — no afirma nada de Meta.
  return {
    label: 'Se sincroniza',
    tono: 'ink',
    ayuda: 'Está habilitado para sincronizarse. Todavía no lo comparamos con lo publicado.',
  };
}

/** ¿El catálogo de este tenant lo gobierna una fuente externa? */
export function catalogoGobernadoAfuera(own: CatalogOwnershipStatus | null): boolean {
  if (!own || !own.configurado) return false;
  return own.model === 'external_managed' || own.externos.length > 0;
}

/**
 * Motivo (en criollo) por el que VendeYaPy no puede publicar ningún dato. '' si sí puede.
 *
 * FAIL-CLOSED (ADR-0015 §2 y §7): `own === null` significa que NO pudimos leer quién administra
 * el catálogo (la consulta está cargando o falló). Habilitar igual sería exactamente el modo de
 * falla que este programa viene a cerrar: la tarjeta de propiedad rompía siempre y el panel
 * ofrecía el opt-in y el envío como si VendeYaPy gobernara el catálogo. Si no sabemos quién
 * manda, asumimos que no somos nosotros y lo decimos.
 */
export function motivoSinCamposPropios(
  own: CatalogOwnershipStatus | null,
  opts?: { cargando?: boolean },
): string {
  if (!own) {
    return opts?.cargando
      ? 'Estamos verificando quién administra el catálogo.'
      : 'No pudimos verificar quién administra el catálogo.';
  }
  // ADR-0022 §4: la relación declarada manda ANTES que la propiedad por campos. Con `none`
  // o `mirror` no existe escritura hacia Meta aunque la propiedad diga que hay campos
  // propios (combinación incoherente ⇒ fail-closed con el motivo de la relación).
  const porRelacion = motivoBloqueoPorRelacion(own.autoridad, nombreFuentePublicadora(own));
  if (porRelacion) return porRelacion;
  if (!own.configurado || own.propios.length > 0) return '';
  // ADR-0015 §8: el interruptor apagado se nombra ANTES que la degradación de la propiedad. Con
  // la sync apagada el backend degrada la propiedad porque ni la mira, así que caer en la rama de
  // abajo respondía "todavía nadie declaró qué datos publica cada sistema" incluso con un feed
  // RECONOCIDO. El bloqueo se mantiene igual de cerrado; lo que cambia es que dice la verdad.
  if (own.sincronizacionApagada) {
    return own.gobiernoExterno
      ? 'La sincronización con Meta está apagada. Tu propio sistema sigue publicando el catálogo allá.'
      : 'La sincronización con Meta está apagada.';
  }
  if (own.degradado) {
    return own.motivos.length
      ? etiquetaMotivo(own.motivos[0]!)
      : etiquetaMotivo('ownership_missing');
  }
  if (own.model === 'external_managed') {
    return 'Tu propio sistema administra los datos publicados: VendeYaPy no escribe en el catálogo de Meta.';
  }
  return 'Todavía no hay ningún dato asignado a VendeYaPy para publicar.';
}

export function ProductMetaCell({
  product,
  ownership,
  ownershipCargando = false,
  puedeReconciliar,
  ocupado,
  onHabilitar,
  onDeshabilitar,
}: {
  product: Product;
  /** null = no se pudo leer la propiedad (cargando o error) ⇒ el opt-in queda BLOQUEADO. */
  ownership: CatalogOwnershipStatus | null;
  /** true mientras la consulta de propiedad está en vuelo (cambia solo el texto del bloqueo). */
  ownershipCargando?: boolean;
  puedeReconciliar: boolean;
  ocupado: boolean;
  onHabilitar: (p: Product) => void;
  onDeshabilitar: (p: Product) => void;
}) {
  const uid = useId();
  const [abierto, setAbierto] = useState(false);
  const deriva = useMemo(() => normalizarDerivaProducto(product), [product]);

  const externo = catalogoGobernadoAfuera(ownership);
  const gobernadoAfuera = externo && (!!product.metaRetailerId || product.syncToMeta === true || deriva != null);
  const motivoBloqueo = motivoSinCamposPropios(ownership, { cargando: ownershipCargando });

  const badge = badgeMetaDe(product, deriva);
  const camposDivergentes = deriva?.campos.length ?? 0;
  const hayDetalle = !!deriva && (camposDivergentes > 0 || deriva.estado !== 'verified');

  return (
    <div className="flex flex-col items-start gap-1">
      <StatusBadge tone={badge.tono} className="whitespace-nowrap">
        {badge.label}
      </StatusBadge>
      {/* La explicación va VISIBLE, no en un tooltip: un badge ámbar sin motivo es tan opaco
          como el verde que reemplaza. Cuando hay valores divergentes el detalle desplegable ya
          la muestra, así que acá solo aparece si no hay tabla que abrir. */}
      {badge.tono !== 'mint' && badge.ayuda && camposDivergentes === 0 && !abierto && (
        <span className="text-[11px] leading-snug text-ink-600">{badge.ayuda}</span>
      )}

      {gobernadoAfuera && (
        <StatusBadge tone="ink" className="whitespace-nowrap border border-ink-200">
          Administrado por fuente externa
        </StatusBadge>
      )}

      {product.metaRetailerId && <span className="text-[11px] text-ink-500">↔ {product.metaRetailerId}</span>}

      {hayDetalle && (
        <>
          <button
            type="button"
            onClick={() => setAbierto((v) => !v)}
            aria-expanded={abierto}
            aria-controls={`${uid}-detalle`}
            className="rounded text-[11px] font-medium text-ink-700 underline-offset-2 hover:underline focus:outline-none focus:ring-2 focus:ring-mint-500/40"
          >
            {/* Sin valores divergentes no hay "diferencia" que ver: lo que se abre es el qué
                hacer (verificación vencida, artículo que dejó de aparecer publicado, etc.). */}
            {camposDivergentes > 0
              ? abierto
                ? 'Ocultar diferencia'
                : 'Ver la diferencia'
              : abierto
                ? 'Ocultar el detalle'
                : 'Ver qué hacer'}
            <span aria-hidden="true"> {abierto ? '▴' : '▾'}</span>
          </button>
          {abierto && (
            <div id={`${uid}-detalle`} className="mt-1 w-full min-w-[16rem] rounded-lg border border-ink-100 bg-ink-50/40 p-2">
              <MetaDriftDetail deriva={deriva!} fuente={ownership?.fuentes[0]?.nombre ?? ''} />
            </div>
          )}
        </>
      )}

      {puedeReconciliar &&
        (product.syncToMeta === true ? (
          <button
            type="button"
            onClick={() => onDeshabilitar(product)}
            disabled={ocupado}
            className="rounded text-[11px] font-medium text-mint-700 underline-offset-2 hover:underline focus:outline-none focus:ring-2 focus:ring-mint-500/40 disabled:opacity-50"
          >
            Dejar de sincronizar
          </button>
        ) : motivoBloqueo ? (
          <>
            {/* Bloqueo VISIBLE: el botón queda inerte y el motivo se lee al lado (no en un tooltip). */}
            <button
              type="button"
              disabled
              aria-describedby={`${uid}-motivo`}
              className="cursor-not-allowed rounded text-[11px] font-medium text-ink-400"
            >
              Sincronizar con Meta…
            </button>
            <span id={`${uid}-motivo`} className="text-[11px] text-ink-600">
              No se puede activar: {motivoBloqueo}
            </span>
          </>
        ) : (
          <button
            type="button"
            onClick={() => onHabilitar(product)}
            disabled={ocupado}
            className="rounded text-[11px] font-medium text-mint-700 underline-offset-2 hover:underline focus:outline-none focus:ring-2 focus:ring-mint-500/40 disabled:opacity-50"
          >
            Sincronizar con Meta…
          </button>
        ))}
    </div>
  );
}
