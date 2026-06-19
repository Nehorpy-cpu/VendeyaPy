/**
 * billing/provider.ts — Interfaz del proveedor de billing de plataforma (Fase 5B-ii)
 * =================================================================================
 * Capa INYECTABLE: la implementación real (PayPal) usa HTTP; en emulador/tests se usa un fake
 * (nunca llama al proveedor real). Stripe sigue por su webhook firmado (no necesita esta capa).
 */

export interface ProviderSubscription {
  id: string;
  status: string; // estado del recurso del proveedor (ACTIVE, SUSPENDED, CANCELLED, ...)
  planRef?: string | null; // plan_id del proveedor
  customerId?: string | null;
  customId?: string | null; // enlace a tenantId
  nextBillingTimeMs?: number | null;
}

export interface CreateSubscriptionCtx {
  tenantId: string;
  returnUrl?: string;
  cancelUrl?: string;
}

export interface PlatformBillingProvider {
  /** Crea la suscripción en el proveedor y devuelve su id + la approval URL. */
  createSubscription(planRef: string, ctx: CreateSubscriptionCtx): Promise<{ subscriptionId: string; approvalUrl: string }>;
  /** Consulta el estado actual de una suscripción (para reconciliar). */
  getSubscription(subscriptionId: string): Promise<ProviderSubscription>;
  /** Verifica la firma de un webhook (método oficial del proveedor). */
  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string, webhookId: string): Promise<boolean>;
}
