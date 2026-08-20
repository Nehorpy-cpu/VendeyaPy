'use client';

/**
 * EstadoDeAccion — el resultado de una acción, dicho en pantalla.
 * ==============================================================
 * H-03 (auditoría 2026-08-19): varias pantallas ejecutaban una mutación y, si el backend
 * rechazaba, **no mostraban nada**: el botón volvía de «Guardando…» a «Guardar cambios» como si
 * hubiera salido bien y el trabajo del dueño se perdía al recargar.
 *
 * Es un componente PRESENTACIONAL a propósito: no maneja mutaciones ni estado. La lógica queda
 * local en cada pantalla, siguiendo `ManualActivationPanel` — un hook genérico que envolviera las
 * ~30 mutaciones del panel cambiaría el comportamiento de todas a la vez.
 *
 * Accesibilidad — las dos mitades se anuncian por vías distintas, a propósito:
 * - El error se pinta con `role="alert"`. Un `alert` insertado en el DOM SÍ se anuncia solo.
 * - El éxito viaja por una live region `role="status"` **siempre montada** (aunque esté vacía), y
 *   su copia visible va `aria-hidden` para que no se lea dos veces:
 *   un `status` que aparece junto con su texto no se anuncia de forma confiable, porque el lector
 *   necesitaba estar observando la región desde antes. Por eso el contenedor no desaparece nunca
 *   y solo cambia su contenido.
 */
export function EstadoDeAccion({
  tipo,
  mensaje,
  className = '',
}: {
  tipo: 'ok' | 'error';
  mensaje: string | null | undefined;
  /** Para acomodarlo al layout de cada pantalla sin tocar el resto del estilo. */
  className?: string;
}) {
  const esError = tipo === 'error';
  return (
    <>
      {/* Live region estable: solo lleva el texto de éxito (el error ya se anuncia como alert). */}
      <div role="status" aria-live="polite" className="sr-only">
        {!esError && mensaje ? mensaje : ''}
      </div>
      {mensaje ? (
        <p
          // Sin `key`, ir de éxito a error reutiliza el nodo y el `alert` no se anuncia: tiene que
          // ser un elemento NUEVO en el DOM.
          key={tipo}
          {...(esError ? { role: 'alert' as const } : { 'aria-hidden': true })}
          className={
            'rounded-xl px-3.5 py-2.5 text-sm ring-1 ring-inset ' +
            (esError
              ? 'bg-coral-50 text-coral-700 ring-coral-100'
              : 'bg-mint-50 text-mint-700 ring-mint-100') +
            (className ? ' ' + className : '')
          }
        >
          {mensaje}
        </p>
      ) : null}
    </>
  );
}
