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
  Tenant,
} from '@vpw/shared';
import { doc, getDoc, collection, collectionGroup, query, where, orderBy, limit, getDocs } from 'firebase/firestore';
import { httpsCallable, type FunctionsError } from 'firebase/functions';
import { firebaseDb, firebaseFunctions } from './firebase';
import type { Role } from './auth-context';

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
  /** Precio de referencia en USD (legacy). El precio COMERCIAL en Paraguay es `pricePygPerMonth`. */
  priceUsdPerMonth: number;
  /** Precio comercial mensual en guaraníes (PLAN-LIMITS-2B) — fuente para mostrar al cliente. */
  pricePygPerMonth?: number;
  /** Días de prueba gratis (PLAN-LIMITS-FREE-TRIAL). Solo el plan `free` (7). Espejo de Plan.trialDays. */
  trialDays?: number;
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
 * Catálogo de planes — espejo de `plans/plans.ts` del backend (fuente de verdad: `plans/{id}`).
 * PLAN-LIMITS-4: `features` alineadas EXACTO con el backend. Hoy las únicas features enforceadas
 * son `aiAssistant` (Básico+) y `marketingAutomation` (Pro+). Las demás (pagos/facturación/multicanal/
 * soporte) están en `false` en TODOS los planes (ver `UPCOMING_FEATURES`): se muestran como
 * "Próximamente", NUNCA como incluidas. No prometer features que el backend no habilita.
 */
export const PLAN_CATALOG: PlanView[] = [
  {
    id: 'free',
    tier: 'FREE',
    name: 'Prueba gratis',
    description: 'Probá la plataforma 7 días con límites básicos.',
    priceUsdPerMonth: 0,
    pricePygPerMonth: 0,
    trialDays: 7,
    // PLAN-LIMITS-FREE-TRIAL: prueba acotada de 7 días (no permanente). Límites bajos espejo de plans.ts.
    limits: { maxProducts: 20, maxOrdersPerMonth: 10, maxWhatsappMessagesPerMonth: 50, maxDeliveryPersons: 1, maxUsers: 2, maxWhatsappNumbers: 1, maxAdSyncsPerMonth: 0, maxAiTokensPerMonth: 0 },
    features: F({}),
  },
  {
    id: 'starter',
    tier: 'STARTER',
    name: 'Básico',
    description: 'Para empezar a vender por WhatsApp.',
    priceUsdPerMonth: 29,
    pricePygPerMonth: 150_000,
    limits: { maxProducts: 200, maxOrdersPerMonth: 500, maxWhatsappMessagesPerMonth: 5000, maxDeliveryPersons: 10, maxUsers: 5, maxWhatsappNumbers: 1, maxAdSyncsPerMonth: 0, maxAiTokensPerMonth: 50000 },
    features: F({ aiAssistant: true }),
  },
  {
    id: 'growth',
    tier: 'GROWTH',
    name: 'Pro',
    description: 'Atribución real y automatización.',
    priceUsdPerMonth: 79,
    pricePygPerMonth: 350_000,
    popular: true,
    limits: { maxProducts: 1000, maxOrdersPerMonth: 2000, maxWhatsappMessagesPerMonth: 20000, maxDeliveryPersons: 50, maxUsers: 15, maxWhatsappNumbers: 3, maxAdSyncsPerMonth: 30, maxAiTokensPerMonth: 250000 },
    features: F({ aiAssistant: true, marketingAutomation: true }),
  },
  {
    id: 'pro',
    tier: 'PRO',
    name: 'Max',
    description: 'Volumen alto y soporte prioritario.',
    priceUsdPerMonth: 199,
    pricePygPerMonth: 650_000,
    limits: { maxProducts: 10000, maxOrdersPerMonth: 20000, maxWhatsappMessagesPerMonth: 100000, maxDeliveryPersons: 200, maxUsers: 50, maxWhatsappNumbers: 10, maxAdSyncsPerMonth: 300, maxAiTokensPerMonth: 1000000 },
    features: F({ aiAssistant: true, marketingAutomation: true }),
  },
  {
    id: 'enterprise',
    tier: 'ENTERPRISE',
    name: 'Enterprise',
    description: 'Límites a medida y multimarca.',
    priceUsdPerMonth: 0,
    pricePygPerMonth: 0,
    customPrice: true,
    limits: { maxProducts: UNLIMITED, maxOrdersPerMonth: UNLIMITED, maxWhatsappMessagesPerMonth: UNLIMITED, maxDeliveryPersons: UNLIMITED, maxUsers: UNLIMITED, maxWhatsappNumbers: UNLIMITED, maxAdSyncsPerMonth: UNLIMITED, maxAiTokensPerMonth: UNLIMITED },
    features: F({ aiAssistant: true, marketingAutomation: true }),
  },
];

export const planById = (id: string): PlanView | undefined => PLAN_CATALOG.find((p) => p.id === id);
export const planByTier = (tier: PlanTier): PlanView | undefined => PLAN_CATALOG.find((p) => p.tier === tier);
/** Orden de tiers para comparar "más alto / más bajo". */
export const TIER_ORDER: PlanTier[] = ['FREE', 'STARTER', 'GROWTH', 'PRO', 'ENTERPRISE'];
export const tierRank = (tier: PlanTier) => TIER_ORDER.indexOf(tier);

/**
 * Etiqueta de precio COMERCIAL del plan (PLAN-LIMITS-2B). Paraguay = guaraníes:
 * usa `pricePygPerMonth` si existe; "A medida" para Enterprise; "Gratis" si es 0;
 * solo cae al USD legacy (`US$…`) si el plan no tiene precio en guaraníes.
 */
export function formatPlanPrice(plan: Pick<PlanView, 'customPrice' | 'pricePygPerMonth' | 'priceUsdPerMonth'>): string {
  if (plan.customPrice) return 'A medida';
  const pyg = plan.pricePygPerMonth;
  if (pyg != null) return pyg === 0 ? 'Gratis' : `₲${pyg.toLocaleString('es-PY')}/mes`;
  return plan.priceUsdPerMonth === 0 ? 'Gratis' : `US$${plan.priceUsdPerMonth}/mes`;
}

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
  /** Prueba gratis (TRIAL-ENFORCEMENT-1A/1B). Espejo de `Tenant.trial`; el estado se deriva con `lib/trial.ts`. */
  trial?: Tenant['trial'];
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

/**
 * Features REALMENTE enforceadas hoy por el backend (PLAN-LIMITS-2/3A/3B). Son las ÚNICAS que se
 * muestran como "incluidas" por plan (check/dash). El resto del catálogo de `PlanFeatures` está en
 * `false` en todos los planes → no se muestran como incluidas, sino en `UPCOMING_FEATURES`.
 */
export const ENFORCED_FEATURES: PlanFeatureKey[] = ['aiAssistant', 'marketingAutomation'];

/**
 * Roadmap: capacidades que el backend tiene en `false`/`planned`/`not_started` (PLAN-LIMITS-3B).
 * Se muestran como "Próximamente" — NUNCA como incluidas en un plan. No prometer disponibilidad ni
 * "desde el plan X". Cuando el backend implemente su gate y las prenda en un plan, pasan a la lista
 * de features incluidas. Ver docs/plan-limits.md §11.
 */
export const UPCOMING_FEATURES: { label: string }[] = [
  { label: 'Pagos online (Bancard, Stripe, billeteras locales)' },
  { label: 'Facturación electrónica' },
  { label: 'Multicanal completo: Instagram y Messenger' },
  { label: 'Soporte prioritario' },
];

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
/* Lectura real del doc `tenants/{tenantId}` + callables MB-2. Poner en `true` para aislar a dev. */
export const USE_MOCK = false;

// --- Estado mock de demo (un tenant en GROWTH, al día, con uso de muestra) ---
const MOCK_PLAN_ID = 'growth';
const MOCK_STATUS: SubscriptionStatus = 'active';
const MOCK_IS_DEMO = false;

/** Lee el doc del tenant (las reglas permiten read a viewer+/owner/admin). */
async function readTenant(tenantId: string): Promise<Partial<Tenant> | undefined> {
  const snap = await getDoc(doc(firebaseDb(), 'tenants', tenantId));
  return snap.exists() ? (snap.data() as Partial<Tenant>) : undefined;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const fmtDate = (d: Date): string => `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;

/**
 * Espejo de `resolveEntitlements(tenantId)`.
 * TODO(5B): reemplazar por `httpsCallable(functions,'resolveEntitlements')({})`
 * (el tenant sale del token; PLATFORM_ADMIN pasa tenantId).
 */
export async function resolveEntitlements(tenantId: string): Promise<ResolvedEntitlements> {
  if (USE_MOCK) {
    const plan = planById(MOCK_PLAN_ID) ?? PLAN_CATALOG[0]!;
    return { planId: plan.id, tier: plan.tier, subscriptionStatus: MOCK_STATUS, isDemo: MOCK_IS_DEMO, limits: plan.limits, features: plan.features, posture: billingPosture(MOCK_STATUS, MOCK_IS_DEMO) };
  }
  const t = await readTenant(tenantId);
  const plan = planById(t?.planId ?? 'free') ?? PLAN_CATALOG[0]!;
  const status = (t?.subscription?.status ?? 'none') as SubscriptionStatus;
  const isDemo = !!t?.isDemo;
  return {
    planId: plan.id,
    tier: plan.tier,
    subscriptionStatus: status,
    isDemo,
    limits: (t?.limits as PlanLimits | undefined) ?? plan.limits,
    features: plan.features,
    posture: billingPosture(status, isDemo),
    trial: t?.trial, // server-set; el estado (activo/vencido/días) se deriva con lib/trial.ts
  };
}

/**
 * Uso mensual + conteos puntuales contra los límites efectivos.
 * TODO(5B): combinar `tenant.usage` real + `count()` de productos/usuarios/números.
 */
export async function getUsage(tenantId: string, ent: ResolvedEntitlements): Promise<UsageView> {
  let used: Record<UsageMetric, number>;
  if (USE_MOCK) {
    used = { messages: 8420, orders: 612, products: 184, users: 6, whatsappNumbers: 1, adSyncs: 12, aiTokens: 73120 };
  } else {
    const u = (await readTenant(tenantId))?.usage;
    // Contadores mensuales reales (tenant.usage). Los conteos puntuales (productos/usuarios/números)
    // requieren count() — fuera de alcance MB-3; se muestran en 0 hasta cablearlos.
    used = {
      messages: u?.messagesThisMonth ?? 0,
      orders: u?.ordersThisMonth ?? 0,
      products: 0,
      users: 0,
      whatsappNumbers: 0,
      adSyncs: u?.adSyncsThisMonth ?? 0,
      aiTokens: u?.aiTokensThisMonth ?? 0,
    };
  }
  const items: UsageItem[] = (Object.keys(METRIC_META) as UsageMetric[]).map((metric) => ({
    metric,
    label: METRIC_META[metric].label,
    period: METRIC_META[metric].period,
    used: used[metric],
    limit: ent.limits[LIMIT_KEY[metric]],
  }));
  return { items, periodLabel: USE_MOCK ? 'Período actual (mock)' : 'Período actual' };
}

/**
 * Estado de la suscripción de plataforma.
 * TODO(5B): leer `tenant.subscription` real (status, planId, currentPeriodEnd).
 */
export async function getSubscription(tenantId: string): Promise<SubscriptionView> {
  if (USE_MOCK) {
    return { status: MOCK_STATUS, planId: MOCK_PLAN_ID, currentPeriodEndLabel: '15/07/2026', hasStripeCustomer: true };
  }
  const sub = (await readTenant(tenantId))?.subscription;
  const end = sub?.currentPeriodEnd as { toDate?: () => Date } | null | undefined;
  return {
    status: (sub?.status ?? 'none') as SubscriptionStatus,
    planId: sub?.planId ?? 'free',
    currentPeriodEndLabel: end?.toDate ? fmtDate(end.toDate()) : null,
    hasStripeCustomer: !!sub?.stripeCustomerId,
  };
}

/**
 * Roles que pueden ejecutar acciones del panel (mismo criterio que el backend `resolvePanelAuth`:
 * PLATFORM_ADMIN / TENANT_OWNER / TENANT_MANAGER). Vendedor/lector: denegado. Se usa para mostrar u
 * ocultar los botones de jobs; el backend igual revalida.
 */
const PANEL_JOB_ROLES: Role[] = ['PLATFORM_ADMIN', 'TENANT_OWNER', 'TENANT_MANAGER'];
export function canRunPanelJobs(role: Role | null): boolean {
  return !!role && PANEL_JOB_ROLES.includes(role);
}

/**
 * Dispara una acción de mantenimiento del tenant vía el callable autenticado `runTenantJob`
 * (GROWTH-JOBS-WIRING). Reemplaza los endpoints `dev*`. El backend autoriza por rol+tenant
 * (panel/auth.ts) y aplica entitlements; acá NO se inventa lógica. `tenantId` es opcional para
 * owner/manager (el backend usa el del token) y obligatorio para PLATFORM_ADMIN.
 */
export async function runTenantJob(action: TenantJobAction, tenantId?: string): Promise<TenantJobResult> {
  const call = httpsCallable<{ action: TenantJobAction; tenantId?: string }, { ok: boolean; action: TenantJobAction; tenantId: string; result: unknown }>(
    firebaseFunctions(),
    'runTenantJob',
  );
  const res = await call(tenantId ? { action, tenantId } : { action });
  return { ok: res.data.ok, action: res.data.action, result: res.data.result, wired: true };
}

/** Mapea errores del callable `runTenantJob` a mensajes claros en español para la UI. */
export function friendlyJobError(e: unknown): string {
  const err = e as Partial<FunctionsError> & { code?: string; message?: string };
  const code = err?.code ?? '';
  if (code === 'functions/permission-denied') return 'Tu rol no puede ejecutar esta acción.';
  if (code === 'functions/failed-precondition') return err.message || 'Esta acción no está disponible para tu plan actual.';
  if (code === 'functions/resource-exhausted') return 'Alcanzaste el límite de tu plan para esta acción este mes.';
  if (code === 'functions/unavailable') return 'El servicio no está disponible por un momento. Probá de nuevo.';
  if (code === 'functions/unauthenticated') return 'Iniciá sesión para continuar.';
  if (code === 'functions/invalid-argument') return err.message || 'No se pudo ejecutar la acción.';
  return err.message || 'No se pudo ejecutar la acción. Probá de nuevo.';
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

/* ====================== Billing manual por WhatsApp (MB-3) ================= */
/* Cableado a los callables MB-2: requestManualPlanActivation / manualBillingActivate /
 * manualBillingCancelRequest. La activación del plan SIEMPRE la hace el PLATFORM_ADMIN; el owner
 * solo SOLICITA. Las solicitudes son de SOLO LECTURA para el cliente (write:false en rules). */

export type ManualActivationStatusView = 'pending' | 'approved' | 'cancelled';

/** Vista de una solicitud de activación manual (lectura del doc). `requestedAt` es un Timestamp Firestore. */
export interface ManualActivationRequestView {
  id: string;
  tenantId: string;
  planId: string;
  status: ManualActivationStatusView;
  method: string;
  requestedByUid: string;
  requestedByRole: string;
  requestedAt?: { toDate?: () => Date } | null;
  note: string | null;
  paymentReference: string | null;
}

export interface ManualActivationRequestResult {
  ok: boolean;
  requestId: string;
  planId: string;
  status: string;
  whatsappText: string;
  whatsappData: { tenantId: string; businessName: string; planId: string; planName: string; priceUsdPerMonth: number; method: string; requestId: string };
}

/** Métodos de pago manual (espejo de MANUAL_PAYMENT_METHOD del backend). */
export const MANUAL_METHODS: { id: string; label: string }[] = [
  { id: 'transferencia', label: 'Transferencia' },
  { id: 'deposito', label: 'Depósito' },
  { id: 'giro', label: 'Giro' },
];

/** Crea la solicitud de activación manual (owner/admin). Devuelve el texto prellenado de WhatsApp. */
export async function requestManualActivation(tenantId: string, planId: string, method: string, note?: string): Promise<ManualActivationRequestResult> {
  const call = httpsCallable<{ tenantId?: string; planId: string; method: string; note?: string }, ManualActivationRequestResult>(firebaseFunctions(), 'requestManualPlanActivation');
  return (await call({ tenantId, planId, method, note })).data;
}

/** Última solicitud del tenant (o null). Permite mostrar pending/approved/cancelled y evitar duplicados. */
export async function getMyActivationRequest(tenantId: string): Promise<ManualActivationRequestView | null> {
  const snap = await getDocs(query(collection(firebaseDb(), 'tenants', tenantId, 'manualActivationRequests'), orderBy('requestedAt', 'desc'), limit(1)));
  return snap.empty ? null : (snap.docs[0]!.data() as ManualActivationRequestView);
}

/** Arma el link wa.me con NEXT_PUBLIC_SUPPORT_WHATSAPP (normalizado a solo dígitos). null si falta el número. */
export function buildWhatsappUrl(text: string): string | null {
  const digits = (process.env['NEXT_PUBLIC_SUPPORT_WHATSAPP'] ?? '').replace(/[^0-9]/g, '');
  if (!digits) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

/** (PLATFORM_ADMIN) Solicitudes pendientes de TODOS los tenants (collectionGroup; índice MB-1). */
export async function listPendingActivations(): Promise<ManualActivationRequestView[]> {
  const snap = await getDocs(query(collectionGroup(firebaseDb(), 'manualActivationRequests'), where('status', '==', 'pending'), orderBy('requestedAt', 'desc')));
  return snap.docs.map((d) => d.data() as ManualActivationRequestView);
}

/** (PLATFORM_ADMIN) Aprueba la solicitud y activa el plan (manualBillingActivate). */
export async function approveActivation(tenantId: string, requestId: string, paymentReference: string): Promise<{ ok: boolean; status: string; planId: string }> {
  const call = httpsCallable<{ tenantId: string; requestId: string; paymentReference: string }, { ok: boolean; status: string; planId: string }>(firebaseFunctions(), 'manualBillingActivate');
  return (await call({ tenantId, requestId, paymentReference })).data;
}

/** Cancela una solicitud (admin: cualquiera; owner: solo la suya pending). No toca el plan vigente. */
export async function cancelActivation(tenantId: string, requestId: string, reason?: string): Promise<{ ok: boolean; status: string }> {
  const call = httpsCallable<{ tenantId: string; requestId: string; reason?: string }, { ok: boolean; status: string }>(firebaseFunctions(), 'manualBillingCancelRequest');
  return (await call({ tenantId, requestId, reason })).data;
}
