/**
 * lectura.ts — cómo se le cuenta al dueño que una lectura no salió.
 *
 * H-15 (auditoría 2026-08-19): las pantallas calculaban sus estados vacíos con `data ?? []`, así
 * que una lectura fallida se mostraba como «no hay nada». Al arreglarlo aparecieron dos matices
 * que no se ven hasta que se leen los estados reales de react-query:
 *
 * 1. `isError` NO significa «no tengo datos»: un refetch en background que falla deja `status:
 *    'error'` **conservando** `data` (query-core `query.js`, el reducer de `error` no toca `data`).
 *    Si se avisa ahí, se le dice al dueño que la pantalla está rota cuando en realidad está
 *    mirando sus datos reales. Por eso se usa `isLoadingError` = error SIN datos.
 * 2. Sin conexión, la primera lectura queda `pending` + `paused`: ni `isLoading`, ni `isError`,
 *    ni `isSuccess`. Los tres bloques habituales dan false y la sección queda **en blanco** — la
 *    pantalla muda otra vez, por otro camino. (Con datos ya cargados, `paused` no molesta a
 *    nadie: lo que se ve es real, solo que no se está refrescando.)
 */

/** Lo mínimo de un `UseQueryResult` que hace falta para decidir el aviso. */
export interface EstadoDeLectura {
  isLoadingError: boolean;
  isPaused: boolean;
  /** Lo ya leído. Si hay algo, la pantalla muestra datos reales y no hay nada que avisar. */
  data: unknown;
}

/**
 * Devuelve el aviso que corresponde a una lectura, o `null` si no hay nada que decir.
 * `sujeto` se completa en minúscula y en segunda persona: «tus promociones», «tus campañas».
 */
export function avisoDeLectura(q: EstadoDeLectura, sujeto: string): string | null {
  // `isPaused` también se enciende cuando un refetch por foco se queda sin red teniendo datos
  // buenos en pantalla: ahí no hay nada roto que contar.
  if (q.isPaused && q.data === undefined) {
    return `Parece que estás sin conexión, así que no pudimos leer ${sujeto}. Se actualiza solo cuando vuelva.`;
  }
  if (q.isLoadingError) {
    return `No pudimos leer ${sujeto}. Recargá la página para intentar de nuevo.`;
  }
  return null;
}
