/**
 * billing/paypal/paypalProvider.ts — Proveedor PayPal Subscriptions (Fase 5B-ii)
 * =============================================================================
 * Implementa PlatformBillingProvider con la REST API de PayPal:
 *   - OAuth2 client_credentials (token cacheado en memoria; NUNCA logueado).
 *   - createSubscription (POST /v1/billing/subscriptions) → link rel:"approve".
 *   - getSubscription (GET /v1/billing/subscriptions/{id}).
 *   - verifyWebhook (POST /v1/notifications/verify-webhook-signature, método OFICIAL).
 * El dinero va a la cuenta PayPal Business de la PLATAFORMA (PAYPAL_CLIENT_ID/SECRET), nunca a
 * cuentas de tenants. En emulador/tests se usa FakePayPalBillingProvider (no llama a PayPal).
 */
import axios from 'axios';
import { db } from '../../lib/firebase.js';
import { logger } from '../../lib/logger.js';
import type { PlatformBillingProvider, ProviderSubscription, CreateSubscriptionCtx } from '../provider.js';

const baseUrl = (): string => (process.env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com');
const parseTime = (s: string | undefined): number | null => {
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
};

export class PayPalBillingProvider implements PlatformBillingProvider {
  private token: { value: string; expiresAtMs: number } | null = null;

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAtMs > now + 60_000) return this.token.value;
    const clientId = process.env.PAYPAL_CLIENT_ID;
    const secret = process.env.PAYPAL_CLIENT_SECRET;
    if (!clientId || !secret) throw new Error('PayPal no configurado (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET).');
    const basic = Buffer.from(`${clientId}:${secret}`).toString('base64');
    const res = await axios.post(`${baseUrl()}/v1/oauth2/token`, 'grant_type=client_credentials', {
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10_000,
    });
    const value = res.data?.access_token as string;
    const expiresInSec = (res.data?.expires_in as number) ?? 3000;
    this.token = { value, expiresAtMs: now + expiresInSec * 1000 };
    return value; // NUNCA se loguea
  }

  async createSubscription(planRef: string, ctx: CreateSubscriptionCtx): Promise<{ subscriptionId: string; approvalUrl: string }> {
    const token = await this.getAccessToken();
    const res = await axios.post(
      `${baseUrl()}/v1/billing/subscriptions`,
      {
        plan_id: planRef,
        custom_id: ctx.tenantId, // enlace suscripción → tenant
        application_context: {
          user_action: 'SUBSCRIBE_NOW',
          ...(ctx.returnUrl ? { return_url: ctx.returnUrl } : {}),
          ...(ctx.cancelUrl ? { cancel_url: ctx.cancelUrl } : {}),
        },
      },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 10_000 },
    );
    const subscriptionId = res.data?.id as string;
    const approveLink = (res.data?.links as Array<{ rel?: string; href?: string }> | undefined)?.find((l) => l.rel === 'approve');
    const approvalUrl = approveLink?.href ?? '';
    return { subscriptionId, approvalUrl };
  }

  async getSubscription(subscriptionId: string): Promise<ProviderSubscription> {
    const token = await this.getAccessToken();
    const res = await axios.get(`${baseUrl()}/v1/billing/subscriptions/${subscriptionId}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10_000,
    });
    const d = res.data ?? {};
    return {
      id: d.id ?? subscriptionId,
      status: d.status ?? '',
      planRef: d.plan_id ?? null,
      customerId: d.subscriber?.payer_id ?? null,
      customId: d.custom_id ?? null,
      nextBillingTimeMs: parseTime(d.billing_info?.next_billing_time),
    };
  }

  async verifyWebhook(headers: Record<string, string | undefined>, rawBody: string, webhookId: string): Promise<boolean> {
    try {
      const token = await this.getAccessToken();
      const res = await axios.post(
        `${baseUrl()}/v1/notifications/verify-webhook-signature`,
        {
          auth_algo: headers['paypal-auth-algo'],
          cert_url: headers['paypal-cert-url'],
          transmission_id: headers['paypal-transmission-id'],
          transmission_sig: headers['paypal-transmission-sig'],
          transmission_time: headers['paypal-transmission-time'],
          webhook_id: webhookId,
          webhook_event: JSON.parse(rawBody),
        },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 10_000 },
      );
      return res.data?.verification_status === 'SUCCESS';
    } catch (e) {
      logger.error('PayPal: verificación de webhook falló', e);
      return false;
    }
  }
}

/** Fake para emulador/tests: NUNCA llama a PayPal. verifyWebhook acepta según un header de test. */
export class FakePayPalBillingProvider implements PlatformBillingProvider {
  async createSubscription(_planRef: string, ctx: CreateSubscriptionCtx): Promise<{ subscriptionId: string; approvalUrl: string }> {
    const subscriptionId = `sub_${ctx.tenantId}`;
    return { subscriptionId, approvalUrl: `https://www.paypal.fake/checkoutnow?token=${subscriptionId}` };
  }
  async getSubscription(subscriptionId: string): Promise<ProviderSubscription> {
    const fx = (await db().doc('paypalTestFixtures/sub').get()).data() as Record<string, unknown> | undefined;
    return {
      id: subscriptionId,
      status: (fx?.status as string) ?? 'ACTIVE',
      planRef: (fx?.plan_id as string) ?? null,
      customerId: (fx?.payer_id as string) ?? null,
      customId: (fx?.custom_id as string) ?? null,
      nextBillingTimeMs: parseTime(fx?.next_billing_time as string | undefined),
    };
  }
  async verifyWebhook(headers: Record<string, string | undefined>, _rawBody: string, _webhookId: string): Promise<boolean> {
    return headers['x-paypal-test-valid'] === 'true';
  }
}

const isEmulator = () => process.env.FUNCTIONS_EMULATOR === 'true';

/** Proveedor activo: fake en emulador/tests, PayPal real en producción. */
export function getPayPalProvider(): PlatformBillingProvider {
  return isEmulator() ? new FakePayPalBillingProvider() : new PayPalBillingProvider();
}
