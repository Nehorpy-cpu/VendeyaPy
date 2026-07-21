/**
 * SHIPPING-CHAT-3B — Enmascarado central de identificadores sensibles para LOGS.
 * ==============================================================================
 * En este modelo el `customerId` ES el teléfono del cliente: jamás debe viajar completo a los
 * logs. Este helper es la ÚNICA forma autorizada de referenciar teléfonos/customerIds/PNIDs en
 * logging (los IDs completos siguen persistiéndose en Firestore donde corresponde — esto es
 * SOLO para logs). Puro, sin dependencias.
 */

/**
 * `…1234` — últimos 4 caracteres. NUNCA devuelve el valor completo: un identificador de 4
 * caracteres o menos se oculta entero ('(oculto)') — mostrar sus "últimos 4" sería mostrarlo
 * todo. Vacío/null/undefined ⇒ '(sin dato)'.
 */
export function maskPhone(value: string | null | undefined): string {
  if (typeof value !== 'string' || value.length === 0) return '(sin dato)';
  if (value.length <= 4) return '(oculto)';
  return `…${value.slice(-4)}`;
}
