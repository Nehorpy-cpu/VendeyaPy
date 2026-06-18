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
