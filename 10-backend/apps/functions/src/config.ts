/**
 * Configuración centralizada de Cloud Functions.
 * Lee de variables de entorno y Firebase config.
 */

import { z } from 'zod';

const ConfigSchema = z.object({
  nodeEnv: z.enum(['development', 'staging', 'production']).default('development'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // n8n
  n8nBaseUrl: z.string().url(),
  n8nInternalSecret: z.string().min(32),

  // WhatsApp (verifier global del webhook)
  whatsappWebhookVerifyToken: z.string().min(1),
  whatsappAppSecret: z.string().min(1),

  // Encriptación de secretos de tenant
  tenantSecretsEncryptionKey: z.string().min(32),

  // Stripe plataforma (cobro a tenants)
  platformStripeSecretKey: z.string().optional(),
  platformStripeWebhookSecret: z.string().optional(),

  // URLs
  apiBaseUrl: z.string().url(),
  webBaseUrl: z.string().url(),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

let cachedConfig: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  cachedConfig = ConfigSchema.parse({
    nodeEnv: process.env.NODE_ENV,
    logLevel: process.env.LOG_LEVEL,
    n8nBaseUrl: process.env.N8N_BASE_URL,
    n8nInternalSecret: process.env.N8N_INTERNAL_SECRET,
    whatsappWebhookVerifyToken: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
    whatsappAppSecret: process.env.WHATSAPP_APP_SECRET,
    tenantSecretsEncryptionKey: process.env.TENANT_SECRETS_ENCRYPTION_KEY,
    platformStripeSecretKey: process.env.PLATFORM_STRIPE_SECRET_KEY,
    platformStripeWebhookSecret: process.env.PLATFORM_STRIPE_WEBHOOK_SECRET,
    apiBaseUrl: process.env.API_BASE_URL,
    webBaseUrl: process.env.WEB_BASE_URL,
  });

  return cachedConfig;
}
