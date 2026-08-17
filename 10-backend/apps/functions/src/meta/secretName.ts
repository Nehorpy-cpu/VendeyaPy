/**
 * meta/secretName.ts — Nombre seguro del secreto del token Meta por tenant (Fase 4B)
 * ==================================================================================
 * FirestoreSecretStore mapea el `name` a `secrets/{name}` (doc de 2 segmentos), así que
 * el name NO puede contener '/'. (Bug de Fase 4A: oauth.ts usaba `meta-token/${tenantId}`,
 * que producía una ruta de doc inválida.) Este helper genera un name plano y sanitizado.
 */

/** `meta-token-{tenantId sanitizado}` — sin '/', válido para SecretStore. */
export function metaTokenSecretName(tenantId: string): string {
  const safe = tenantId.replace(/[^A-Za-z0-9._-]/g, '_');
  return `meta-token-${safe}`;
}

/**
 * Secreto PENDIENTE de la selección de WABA (ADR-0020, G2): `meta-token-pending-{tenant}`.
 * Determinístico a propósito: a lo sumo UN huérfano por tenant — un nuevo intento de conexión
 * lo sobrescribe, y completar la selección lo retira. Nunca es el secreto que resuelve
 * credenciales (`resolveTenantWhatsappCreds` solo mira `tokenSecretRef` de la conexión).
 */
export function metaPendingTokenSecretName(tenantId: string): string {
  const safe = tenantId.replace(/[^A-Za-z0-9._-]/g, '_');
  return `meta-token-pending-${safe}`;
}

/**
 * Referencia canónica que produce el SecretStore de Firestore para el token de `main`
 * (`secret://firestore/{name}` — el mismo encoding observable en todo `tokenSecretRef` real).
 *
 * Existe SOLO para el reintento idempotente de la desconexión (ADR-0020, G12): si el retiro del
 * secreto falla después de la transacción, la conexión ya quedó `not_connected` con ref vacía y
 * el huérfano no se puede volver a leer de ningún documento — pero el naming es determinístico,
 * así que el reintento lo reconstruye. `remove` ignora referencias de otro esquema (p. ej. la
 * demo `secret://demo/...`), por lo que usarla de fallback nunca borra nada ajeno.
 */
export function metaTokenSecretRefFirestore(tenantId: string): string {
  return `secret://firestore/${metaTokenSecretName(tenantId)}`;
}

/**
 * Secreto POR NÚMERO adicional (MULTI-NUMBER-1): `meta-token-{tenant}-{phoneNumberId}`.
 * El número principal (conexión `main`) conserva el name histórico de metaTokenSecretName.
 */
export function metaNumberTokenSecretName(tenantId: string, phoneNumberId: string): string {
  const safeT = tenantId.replace(/[^A-Za-z0-9._-]/g, '_');
  const safeP = phoneNumberId.replace(/[^A-Za-z0-9._-]/g, '_');
  return `meta-token-${safeT}-${safeP}`;
}
