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
 * Secreto POR NÚMERO adicional (MULTI-NUMBER-1): `meta-token-{tenant}-{phoneNumberId}`.
 * El número principal (conexión `main`) conserva el name histórico de metaTokenSecretName.
 */
export function metaNumberTokenSecretName(tenantId: string, phoneNumberId: string): string {
  const safeT = tenantId.replace(/[^A-Za-z0-9._-]/g, '_');
  const safeP = phoneNumberId.replace(/[^A-Za-z0-9._-]/g, '_');
  return `meta-token-${safeT}-${safeP}`;
}
