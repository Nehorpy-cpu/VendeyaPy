/**
 * Capa ADAPTER de planes / entitlements / uso / billing para el panel.
 *
 * ⚠️ TEMPORAL Y MOCK — Fase 5A está cerrada en backend, pero el FRONTEND todavía no
 * está cableado a los callables. Hasta que 5B (Stripe checkout/portal, cambios de plan)
 * y 5C (callable `productUpsert`) cierren, esta capa devuelve datos MOCK y NO conecta
 * a producción. NO escribe a Firestore para acciones críticas (cambiar plan, billing).
 *
 * Contratos (no inventados): ver docs/planes-entitlements.md y los tipos de @vpw/shared
 * (Plan, PlanLimits, PlanFeatures, TenantSubscription, TenantUsage, enums).
 *
 * Punto de cableado: cuando el backend exponga las lecturas como callables
 * (resolveEntitlements / checkQuota) y las acciones de billing (5B), reemplazar los
 * cuerpos marcados con `TODO(5B)` / `TODO(5C)` por `httpsCallable(...)` y poner
 * USE_MOCK = false. Las firmas de las funciones ya quedan estables para no rehacer UI.
 */

import type {
  PlanLimits,
  PlanFeatures,
  PlanTier,
  SubscriptionStatus,
} from '@vpw/shared';

/** Sentinela de "ilimitado" (evita Infinity en Firestore). Ver doc 5A. */
export const UNLIMITED = 1e9;
export const isUnlimited = (n: number) => n >= UNLIMITED;

/**
 * Proyección de un Plan para la UI. Reusa `PlanLimits`/`PlanFeatures` de @vpw/shared
 * (fidelidad de campos), y omite metadatos de servidor (createdAt/isActive) que la UI
 * no necesita. NO es un contrato nuevo: es una vista del `Plan` de shared.
 */
export interface PlanView {
  id: string;
  tier: PlanTier;
  name: string;
  description: string;
  priceUsdPerMonth: number;
  /** Precio "a medida" (Enterprise): se muestra distinto. */
  customPrice?: boolean;
  popular?: boolean;
  limits: PlanLimits;
  features: PlanFeatures;
}

const F = (over: Partial<PlanFeatures>): PlanFeatures => ({
  bancard: false,
  stripe: false,
  localWallets: false,
  electronicInvoicing: false,
  marketingAutomation: false,
  multiChannel: false,
  prioritySupport: false,
  aiAssistant: false,
  ...over,
});

/**
 * Catálogo de planes — valores de docs/planes-entitlements.md (matriz 5A).
 * Fuente de verdad real: `plans/{id}` en backend; esto es el espejo de marketing/UI.
 */
export const PLAN_CATALOG: PlanView[] = [
  {
    id: 'free',
    tier: 'FREE',
    name: 'Free / Demo',
    description: 'Para probar la plataforma.',
    priceUsdPerMonth: 0,
    limits: { maxProducts: 20, maxOrdersPerMonth: 50, maxWhatsappMessagesPerMonth: 500, maxDeliveryPersons: 2, maxUsers: 2, maxWhatsappNumbers: 1, maxAdSyncsPerMonth: 0, maxAiTokensPerMonth: 0 },
    features: F({}),
  },
  {
    id: 'starter',
    tier: 'STARTER',
    name: 'Starter',
    description: 'Para empezar a vender por WhatsApp.',
    priceUsdPerMonth: 29,
    limits: { maxProducts: 200, maxOrdersPerMonth: 500, maxWhatsappMessagesPerMonth: 5000, maxDeliveryPersons: 10, maxUsers: 5, maxWhatsappNumbers: 1, maxAdSyncsPerMonth: 0, maxAiTokensPerMonth: 50000 },
    features: F({ bancard: true, stripe: true, localWallets: true, multiChannel: true, aiAssistant: true }),
  },
  {
    id: 'growth',
    tier: 'GROWTH',
    name: 'Growth',
    description: 'Atribución real y automatización.',
    priceUsdPerMonth: 79,
    popular: true,
    limits: { maxProducts: 1000, maxOrdersPerMonth: 2000, maxWhatsappMessagesPerMonth: 20000, maxDeliveryPersons: 50, maxUsers: 15, maxWhatsappNumbers: 3, maxAdSyncsPerMonth: 30, maxAiTokensPerMonth: 250000 },
    features: F({ bancard: true, stripe: true, localWallets: true, multiChannel: true, electronicInvoicing: true, marketingAutomation: true, aiAssistant: true }),
  },
  {
    id: 'pro',
    tier: 'PRO',
    name: 'Pro',
    description: 'Volumen alto y soporte prioritario.',
    priceUsdPerMonth: 199,
    limits: { maxProducts: 10000, maxOrdersPerMonth: 20000, maxWhatsappMessagesPerMonth: 100000, maxDeliveryPersons: 200, maxUsers: 50, maxWhatsappNumbers: 10, maxAdSyncsPerMonth: 300, maxAiTokensPerMonth: 1000000 },
    features: F({ bancard: true, stripe: true, localWallets: true, multiChannel: true, electronicInvoicing: true, marketingAutomation: true, aiAssistant: true, prioritySupport: true }),
  },
  {
    id: 'enterprise',
    tier: 'ENTERPRISE',
    name: 'Enterprise',
    description: 'Límites a medida y multimarca.',
    priceUsdPerMonth: 0,
    customPrice: true,
    limits: { maxProducts: UNLIMITED, maxOrdersPerMonth: UNLIMITED, maxWhatsappMessagesPerMonth: UNLIMITED, maxDeliveryPersons: UNLIMITED, maxUsers: UNLIMITED, maxWhatsappNumbers: UNLIMITED, maxAdSyncsPerMonth: UNLIMITED, maxAiTokensPerMonth: UNLIMITED },
    features: F({ bancard: true, stripe: true, localWallets: true, multiChannel: true, electronicInvoicing: true, marketingAutomation: true, aiAssistant: true, prioritySupport: true }),
  },
];

export const planById = (id: string): PlanView | undefined => PLAN_CATALOG.find((p) => p.id === id);
export const planByTier = (tier: PlanTier): PlanView | undefined => PLAN_CATALOG.find((p) => p.tier === tier);
/** Orden de tiers para comparar "más alto / más bajo". */
export const TIER_ORDER: PlanTier[] = ['FREE', 'STARTER', 'GROWTH', 'PRO', 'ENTERPRISE'];
export const tierRank = (tier: PlanTier) => TIER_ORDER.indexOf(tier);

/* --------------------------------- Billing -------------------------------- */

/**
 * Postura de billing derivada del estado de suscripción.
 * Espejo de `billingPosture` de apps/functions/src/entitlements/decide.ts:
 * - `operational` SIEMPRE es true (la cuenta NUNCA se suspende por billing; los
 *   datos se preservan). past_due/canceled/incomplete solo bloquean lo premium.
 * - `premiumAllowed` = puede usar features premium.
 * `level`/`label`/`description` son solo presentación (no existen en el backend).
 */
export interface BillingPosture {
  level: 'ok' | 'demo' | 'grace' | 'premium_suspended';
  /** Espejo de decide.ts `operational` (siempre true: la cuenta no se suspende). */
  operational: boolean;
  premiumAllowed: boolean;
  /** Espejo de decide.ts `reason`. */
  reason: string;
  label: string;
  description: string;
}

export function billingPosture(status: SubscriptionStatus, isDemo: boolean): BillingPosture {
  if (isDemo) {
    return { level: 'demo', operational: true, premiumAllowed: true, reason: 'demo', label: 'Cuenta demo', description: 'No facturable. No se suspende por billing.' };
  }
  switch (status) {
    case 'active':
    case 'trialing':
    case 'none':
      return { level: 'ok', operational: true, premiumAllowed: true, reason: status, label: status === 'trialing' ? 'En prueba' : 'Al día', description: 'Suscripción activa. Acceso completo.' };
    case 'past_due':
      return { level: 'grace', operational: true, premiumAllowed: false, reason: 'past_due', label: 'Pago pendiente', description: 'Seguís operando lo básico; las funciones premium quedan en pausa hasta regularizar el pago.' };
    case 'canceled':
    case 'incomplete':
      return {
        level: 'premium_suspended',
        operational: true,
        premiumAllowed: false,
        reason: status,
        label: status === 'canceled' ? 'Suscripción cancelada' : 'Suscripción incompleta',
        description: 'Las funciones premium quedan en pausa y tus datos se conservan. Seguís operando lo básico; reactivá tu suscripción para volver al plan completo.',
      };
    default:
      return { level: 'ok', operational: true, premiumAllowed: true, reason: 'unknown', label: '—', description: '' };
  }
}

/* ------------------------------ Entitlements ------------------------------ */

/** Contrato espejo de `resolveEntitlements(tenantId)` (doc 5A). */
export interface ResolvedEntitlements {
  planId: string;
  tier: PlanTier;
  subscriptionStatus: SubscriptionStatus;
  isDemo: boolean;
  limits: PlanLimits;
  features: PlanFeatures;
  posture: BillingPosture;
}

export type PlanFeatureKey = keyof PlanFeatures;

export const FEATURE_LABELS: Record<PlanFeatureKey, string> = {
  bancard: 'Pagos con Bancard',
  stripe: 'Pagos con Stripe',
  localWallets: 'Billeteras locales (Tigo/Personal/Zimple)',
  electronicInvoicing: 'Facturación electrónica',
  marketingAutomation: 'Marketing y automatizaciones',
  multiChannel: 'Multicanal (Instagram / Messenger)',
  prioritySupport: 'Soporte prioritario',
  aiAssistant: 'Asistente IA',
};

/** ¿El entitlement actual habilita esta feature? (rol/cuota se validan aparte/backend). */
export function hasFeature(ent: ResolvedEntitlements | null | undefined, feature: PlanFeatureKey): boolean {
  if (!ent) return false;
  return Boolean(ent.features[feature]) && ent.posture.premiumAllowed;
}

/* --------------------------------- Uso ------------------------------------ */

export type UsageMetric =
  | 'messages'
  | 'orders'
  | 'products'
  | 'users'
  | 'whatsappNumbers'
  | 'adSyncs'
  | 'aiTokens';

export interface UsageItem {
  metric: UsageMetric;
  label: string;
  used: number;
  limit: number;
  /** 'month' = contador mensual con reset; 'point' = conteo puntual (count()). */
  period: 'month' | 'point';
}

export interface UsageView {
  items: UsageItem[];
  periodLabel: string;
}

const LIMIT_KEY: Record<UsageMetric, keyof PlanLimits> = {
  messages: 'maxWhatsappMessagesPerMonth',
  orders: 'maxOrdersPerMonth',
  products: 'maxProducts',
  users: 'maxUsers',
  whatsappNumbers: 'maxWhatsappNumbers',
  adSyncs: 'maxAdSyncsPerMonth',
  aiTokens: 'maxAiTokensPerMonth',
};

const METRIC_META: Record<UsageMetric, { label: string; period: 'month' | 'point' }> = {
  messages: { label: 'Mensajes WhatsApp', period: 'month' },
  orders: { label: 'Pedidos', period: 'month' },
  products: { label: 'Productos', period: 'point' },
  users: { label: 'Usuarios', period: 'point' },
  whatsappNumbers: { label: 'Números WhatsApp', period: 'point' },
  adSyncs: { label: 'Syncs de anuncios', period: 'month' },
  aiTokens: { label: 'Tokens IA', period: 'month' },
};

/**
 * Contrato espejo de `decideQuota`/`QuotaDecision` del backend
 * (apps/functions/src/entitlements/decide.ts): { allowed, reason, used, limit, unlimited }.
 */
export type QuotaReason = 'ok' | 'quota_exceeded';

export interface QuotaCheck {
  allowed: boolean;
  reason: QuotaReason;
  used: number;
  limit: number;
  unlimited: boolean;
}

export function checkQuota(usage: UsageView, metric: UsageMetric, delta = 1): QuotaCheck {
  const item = usage.items.find((i) => i.metric === metric);
  if (!item) return { allowed: true, reason: 'ok', used: 0, limit: UNLIMITED, unlimited: true };
  const unlimited = isUnlimited(item.limit);
  const allowed = unlimited || item.used + delta <= item.limit;
  return { allowed, reason: allowed ? 'ok' : 'quota_exceeded', used: item.used, limit: item.limit, unlimited };
}

/* ------------------------------ Suscripción ------------------------------- */

export interface SubscriptionView {
  status: SubscriptionStatus;
  planId: string;
  currentPeriodEndLabel: string | null;
  hasStripeCustomer: boolean;
}

/* ----------------------------- Acciones (jobs) ---------------------------- */

/** Acciones de `runTenantJob` (doc panel-backend.md). */
export const TENANT_JOB_ACTIONS = [
  'metaAdsSync',
  'computeAttribution',
  'catalogSync',
  'generateFollowups',
  'generateAudits',
  'computeTracking',
  'generateWinningReplies',
  'processConversions',
] as const;
export type TenantJobAction = (typeof TENANT_JOB_ACTIONS)[number];

export interface TenantJobResult {
  ok: boolean;
  action: TenantJobAction;
  result: unknown;
  /** true cuando viene del callable real; false = mock local. */
  wired: boolean;
}

/* ================================ ADAPTERS ================================= */
/* Cambiar a `false` cuando el backend exponga los callables (5B/5C). */
export const USE_MOCK = true;

// --- Estado mock de demo (un tenant en GROWTH, al día, con uso de muestra) ---
const MOCK_PLAN_ID = 'growth';
const MOCK_STATUS: SubscriptionStatus = 'active';
const MOCK_IS_DEMO = false;

/**
 * Espejo de `resolveEntitlements(tenantId)`.
 * TODO(5B): reemplazar por `httpsCallable(functions,'resolveEntitlements')({})`
 * (el tenant sale del token; PLATFORM_ADMIN pasa tenantId).
 */
export async function resolveEntitlements(_tenantId: string): Promise<ResolvedEntitlements> {
  const plan = planById(MOCK_PLAN_ID) ?? PLAN_CATALOG[0]!;
  return {
    planId: plan.id,
    tier: plan.tier,
    subscriptionStatus: MOCK_STATUS,
    isDemo: MOCK_IS_DEMO,
    limits: plan.limits,
    features: plan.features,
    posture: billingPosture(MOCK_STATUS, MOCK_IS_DEMO),
  };
}

/**
 * Uso mensual + conteos puntuales contra los límites efectivos.
 * TODO(5B): combinar `tenant.usage` real + `count()` de productos/usuarios/números.
 */
export async function getUsage(_tenantId: string, ent: ResolvedEntitlements): Promise<UsageView> {
  const usedMock: Record<UsageMetric, number> = {
    messages: 8420,
    orders: 612,
    products: 184,
    users: 6,
    whatsappNumbers: 1,
    adSyncs: 12,
    aiTokens: 73120,
  };
  const items: UsageItem[] = (Object.keys(METRIC_META) as UsageMetric[]).map((metric) => ({
    metric,
    label: METRIC_META[metric].label,
    period: METRIC_META[metric].period,
    used: usedMock[metric],
    limit: ent.limits[LIMIT_KEY[metric]],
  }));
  return { items, periodLabel: 'Período actual (mock)' };
}

/**
 * Estado de la suscripción de plataforma.
 * TODO(5B): leer `tenant.subscription` real (status, planId, currentPeriodEnd).
 */
export async function getSubscription(_tenantId: string): Promise<SubscriptionView> {
  return {
    status: MOCK_STATUS,
    planId: MOCK_PLAN_ID,
    currentPeriodEndLabel: '15/07/2026',
    hasStripeCustomer: true,
  };
}

/**
 * Dispara una acción de mantenimiento del tenant.
 * TODO(panel-backend): `httpsCallable(functions,'runTenantJob')({ action })`.
 * Por ahora MOCK (no toca backend ni Firestore).
 */
export async function runTenantJob(action: TenantJobAction): Promise<TenantJobResult> {
  return { ok: true, action, result: { mock: true }, wired: false };
}

/** Resultado de una acción de billing que todavía NO está cableada (5B). */
export interface NotWiredResult {
  wired: false;
  message: string;
}

/**
 * Cambio de plan. NO escribe a Firestore (los campos de plan/billing solo los
 * escribe Admin SDK). TODO(5B): iniciar Stripe Checkout / cambio de plan vía callable.
 */
export async function requestPlanChange(_targetPlanId: string): Promise<NotWiredResult> {
  return { wired: false, message: 'El cambio de plan se habilita cuando se cierre el checkout de Stripe (Fase 5B).' };
}

/**
 * Portal de facturación de Stripe. TODO(5B): callable que devuelve la URL del portal.
 */
export async function openBillingPortal(): Promise<NotWiredResult> {
  return { wired: false, message: 'El portal de facturación se habilita con la integración de Stripe Billing (Fase 5B).' };
}
