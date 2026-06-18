# Runbook interno — AI_AFG / VendeyaPy (Fase 6)

Para el equipo de la plataforma (soporte / operaciones).

## Soporte (alta y gestión de clientes)
- **Alta de empresa:** callable `provisionTenant` (solo PLATFORM_ADMIN) → crea tenant + dueño + plan.
  Ver `docs/onboarding-saas.md`.
- **Usuarios:** `inviteUser` / `setUserRole` / `setUserActive` (las hace el dueño o el admin).
- **Cambio de plan / suspensión:** la suscripción de Stripe gobierna el estado (ACTIVE/SUSPENDED).
  Para suspender/reactivar manualmente: `setTenantStatus` (lifecycle) o gestionar la suscripción.

## Incidentes
1. **Bot no responde:** revisar (a) empresa SUSPENDED o sobre el límite de mensajes del plan
   (`tenant.status` / `tenant.usage`), (b) `botEnabled` en `config/agent`, (c) chat en atención humana.
2. **Webhook fallando:** `metaWebhook` / `stripeWebhook` / `platformBillingWebhook` loguean `ERROR` en
   Cloud Logging. Firma inválida → 401 (no procesa). Revisar secretos (`*_WEBHOOK_SECRET`, `WHATSAPP_APP_SECRET`).
3. **Pago no se acreditó:** buscar el `event.id` en `stripeWebhookEvents` (idempotencia); si no está,
   el webhook no llegó/falló la firma. Reenviar desde Stripe.
4. **Health:** `GET /healthCheck` → `checks.firestore`. 503 = problema de conectividad.
- Toda acción sensible queda en **audit logs** (`tenants/{t}/auditLogs`): quién, qué, cuándo.

## Backup y exportación
- **Export por empresa (portabilidad / soporte):**
  `node scripts/export-tenant.mjs <tenantId> salida.json` (agregá `--include-private` para finanzas).
- **Backup completo de Firestore:** `gcloud firestore export gs://<bucket>-backups` (programar diario
  con Cloud Scheduler). Restore: `gcloud firestore import`.
- **Storage:** las imágenes viven en `tenants/{t}/products/...`; respaldar el bucket con
  `gsutil -m cp -r`.

## Privacidad de datos
- **Qué se guarda:** datos de la empresa, catálogo, clientes (teléfono/nombre de WhatsApp), pedidos,
  conversaciones, métricas.
- **Datos sensibles separados:** costos/ganancia en `productFinancials`/`orderFinancials` (el vendedor
  NO los lee, ni por la base — ADR-0008). Tokens (Meta/pagos) **nunca en claro**: solo referencia
  (`tokenSecretRef`) a secretos cifrados (AES-256-GCM) — ver `lib/secretStore.ts`.
- **Aislamiento entre empresas:** garantizado por reglas Firestore + custom claims (probado en P9).
- **Borrado / "derecho al olvido":** soft-delete del tenant (`status: DELETED`) → el gate frena el bot;
  hard-delete + purga de Storage según política. Export para portabilidad con `export-tenant.mjs`.

## Deploy
Ver `docs/deploy.md` (entornos, workflow de deploy, rollback, checklist de producción).
