'use client';

/**
 * MetaDriftDetail — Diferencias entre lo que tenés acá y lo que está PUBLICADO (ADR-0015 §5).
 *
 * Un solo lugar para el detalle y para la acción recomendada, porque el texto es delicado:
 * cuando el catálogo lo gobierna una fuente externa, la corrección se hace EN EL ORIGEN que
 * genera la publicación. Este panel nunca propone tocar el catálogo de Meta a mano: el
 * origen vuelve a publicar en su próxima pasada y pisaría el arreglo (ese loop diario es
 * justamente lo que el modelo de propiedad viene a hacer imposible).
 */

import type { ProductoDerivaView } from '@/lib/catalog';
import { ESTADO_META_INFO } from '@/lib/catalogOwnership';

/**
 * Qué tiene que hacer el comerciante según el estado. Nunca "editalo en Meta".
 * Exportada para que la tarjeta de propiedad diga EXACTAMENTE lo mismo que la grilla: dos
 * textos distintos para la misma divergencia son dos verdades distintas.
 */
export function accionRecomendada(deriva: ProductoDerivaView, fuente: string): string {
  const donde = fuente ? `el origen que genera ${fuente}` : 'el origen que genera la publicación';
  switch (deriva.estado) {
    case 'drifted_external':
      return `Corregilo en ${donde} (tu sitio o tu sistema de gestión). Cuando vuelva a publicarse con el dato corregido, este aviso se cierra solo.`;
    case 'drifted':
      return 'Revisá el dato en la ficha del producto y volvé a previsualizar el envío.';
    case 'remote_missing':
      return `El artículo dejó de aparecer publicado. Revisalo en ${donde}.`;
    case 'unverifiable':
      return 'No conseguimos leer el catálogo publicado para comparar. Vamos a reintentarlo; mientras tanto no damos por confirmado el precio ni el stock.';
    case 'stale':
      return 'Hace demasiado que no comparamos este artículo. Hasta volver a verificarlo no damos por confirmado el precio ni el stock.';
    default:
      return '';
  }
}

export function MetaDriftDetail({
  deriva,
  /** Nombre SANEADO de la fuente externa (nunca su URL). Opcional. */
  fuente = '',
  className,
}: {
  deriva: ProductoDerivaView;
  fuente?: string;
  className?: string;
}) {
  const info = ESTADO_META_INFO[deriva.estado];
  const accion = accionRecomendada(deriva, fuente);
  return (
    <div className={className ?? 'space-y-2'}>
      <p className="text-xs text-ink-600">{info.ayuda}</p>

      {deriva.campos.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-xs">
            <caption className="sr-only">Diferencias entre tus datos y lo publicado</caption>
            <thead className="text-ink-500">
              <tr>
                <th scope="col" className="py-1 pr-3 font-medium">Dato</th>
                <th scope="col" className="py-1 pr-3 font-medium">En tu sistema</th>
                <th scope="col" className="py-1 pr-3 font-medium">Publicado</th>
              </tr>
            </thead>
            <tbody>
              {deriva.campos.map((c) => (
                <tr key={c.campo} className="align-top">
                  <th scope="row" className="py-1 pr-3 font-medium text-ink-800">
                    {c.etiqueta}
                    {c.critico && <span className="ml-1 text-coral-600" title="Frena la venta automática">•</span>}
                  </th>
                  <td className="py-1 pr-3 text-ink-800">{c.local}</td>
                  <td className="py-1 pr-3 font-semibold text-coral-700">{c.publicado}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {deriva.critico && (
        <p className="rounded-lg bg-coral-50 px-2.5 py-1.5 text-xs text-coral-800">
          Mientras la diferencia siga, el bot <strong>no cierra la venta solo</strong>: avisa y pasa la conversación a
          una persona.
        </p>
      )}

      {accion && (
        <p className="text-xs text-ink-700">
          <span className="font-semibold">Qué hacer:</span> {accion}
        </p>
      )}
    </div>
  );
}
