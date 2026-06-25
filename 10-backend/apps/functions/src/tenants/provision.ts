/**
 * tenants/provision.ts — Alta de una empresa (tenant) desde cero (Fase 4)
 * =======================================================================
 * Crea: tenant doc (plan/límites/uso/estado) + usuario owner en Auth con custom
 * claims { tenantId, role: TENANT_OWNER } + doc users/{uid} + config inicial del
 * agente (saludo por rubro). La plantilla de catálogo completa se aplica luego
 * desde el panel /onboarding. Solo lo invoca un PLATFORM_ADMIN (ver callable).
 */
import { Timestamp } from 'firebase-admin/firestore';
import type { TenantStatus, UserRole } from '@vpw/shared';
import { db, auth, paths } from '../lib/firebase.js';
import { logger } from '../lib/logger.js';
import { ensurePlansSeeded, getPlan } from '../plans/plans.js';
import { recordAudit, type AuditAction } from '../audit/audit.js';

export interface ProvisionTenantInput {
  name: string;
  slug?: string;
  ownerEmail: string;
  ownerName?: string;
  ownerPassword?: string;
  planId?: string;
  industry?: string;
  country?: string;
  currency?: string;
}

export interface ProvisionTenantResult {
  tenantId: string;
  ownerUid: string;
  created: boolean;
}

export const slugify = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);

/** El slug/nombre de empresa ya está tomado (reserva atómica fallida). El callable la mapea a `already-exists`. */
export class TenantSlugTakenError extends Error {
  constructor(public readonly tenantId: string) {
    super(`La empresa "${tenantId}" ya existe`);
    this.name = 'TenantSlugTakenError';
  }
}

/** Input del core con el ownerUid YA resuelto (lo comparten provisionTenant admin y registerTenantOwner self). */
export interface ProvisionCoreInput {
  tenantId: string;
  businessName: string;
  ownerUid: string;
  ownerEmail: string;
  ownerName?: string;
  planId?: string;
  industry?: string;
  country?: string;
  currency?: string;
  phone?: string;
  audit: { action: AuditAction; actorRole: string; self: boolean };
}

const WELCOME_BY_INDUSTRY: Record<string, string> = {
  perfumeria: '¡Hola! 💖 Bienvenida. Soy tu asesora de fragancias. ¿Buscás algo para vos o para regalar?',
  indumentaria: '¡Hola! 👗 Bienvenida. ¿Qué estás buscando hoy? Te ayudo a encontrar tu prenda ideal.',
  cosmetica: '¡Hola! ✨ Bienvenida. ¿Buscás algo en particular o querés que te recomiende?',
  default: '¡Hola! 👋 Gracias por escribirnos. ¿En qué te puedo ayudar?',
};

/**
 * Core compartido: crea el tenant con el ownerUid YA resuelto. RESERVA ATÓMICA del slug
 * (`tenantRef.create()` falla si ya existe → TenantSlugTakenError; sin auto-sufijo). Setea claims
 * { tenantId, role:'TENANT_OWNER' } (rol hardcodeado), doc users/{uid}, config/agent, y audita.
 */
export async function provisionTenantCore(input: ProvisionCoreInput): Promise<ProvisionTenantResult> {
  await ensurePlansSeeded();
  const planId = input.planId ?? 'free';
  const plan = await getPlan(planId);
  if (!plan) throw new Error(`Plan inválido: ${planId}`);

  const now = Timestamp.now();
  const welcome = WELCOME_BY_INDUSTRY[input.industry ?? 'default'] ?? WELCOME_BY_INDUSTRY.default;
  const tenantRef = db().doc(paths.tenant(input.tenantId));

  // TRIAL-ENFORCEMENT-1A: los tenants nuevos en `free` nacen con prueba de `Plan.trialDays` días.
  // `endsAt = startedAt + trialDays`. El backend deriva el vencimiento (no se guarda status). Planes
  // pagos (o `free` sin trialDays) no llevan `trial`.
  const trial =
    planId === 'free' && typeof plan.trialDays === 'number' && plan.trialDays > 0
      ? { startedAt: now, endsAt: Timestamp.fromMillis(now.toMillis() + plan.trialDays * 86_400_000) }
      : undefined;

  // 1) Reserva ATÓMICA del slug: create() falla si el doc ya existe (sin auto-sufijo).
  try {
    await tenantRef.create({
      id: input.tenantId,
      name: input.businessName,
      slug: input.tenantId,
      status: 'ACTIVE' as TenantStatus,
      planId,
      contact: { ownerName: input.ownerName ?? '', email: input.ownerEmail, phone: input.phone ?? '', country: input.country ?? 'PY' },
      branding: { businessName: input.businessName, welcomeMessage: welcome, currency: input.currency ?? 'PYG', timezone: 'America/Asuncion', locale: 'es-PY' },
      limits: plan.limits,
      isDemo: false,
      usage: { ordersThisMonth: 0, messagesThisMonth: 0, jobsThisMonth: 0, adSyncsThisMonth: 0, aiTokensThisMonth: 0, aiCostUsdThisMonth: 0, currentPeriodStart: now },
      subscription: { status: 'none', planId, stripeCustomerId: null, stripeSubscriptionId: null, currentPeriodEnd: null, updatedAt: now },
      onboarding: { completed: false, completedAt: null },
      ...(trial ? { trial } : {}),
      industry: input.industry ?? null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
  } catch (e) {
    if ((await tenantRef.get()).exists) throw new TenantSlugTakenError(input.tenantId);
    throw e;
  }

  // 2) Custom claims del owner (rol HARDCODEADO: nunca PLATFORM_ADMIN, nunca del input).
  await auth().setCustomUserClaims(input.ownerUid, { tenantId: input.tenantId, role: 'TENANT_OWNER' as UserRole });

  // 3) Doc del usuario owner.
  await db().doc(paths.user(input.ownerUid)).set(
    { id: input.ownerUid, email: input.ownerEmail, name: input.ownerName ?? '', role: 'TENANT_OWNER', tenantId: input.tenantId, status: 'ACTIVE', updatedAt: now },
    { merge: true },
  );

  // 4) Config inicial del agente (saludo por rubro). El catálogo se carga desde /onboarding.
  await db().doc(`tenants/${input.tenantId}/config/agent`).set(
    { agentName: 'Asistente', businessName: input.businessName, greetingMessage: welcome, botEnabled: true, profitMode: false, industry: input.industry ?? '', updatedAt: now },
    { merge: true },
  );

  await recordAudit({ tenantId: input.tenantId, action: input.audit.action, actorUid: input.ownerUid, actorRole: input.audit.actorRole, targetType: 'tenant', targetId: input.tenantId, summary: `Empresa creada: ${input.businessName}`, metadata: { self: input.audit.self, planId } });
  logger.info('Empresa aprovisionada', { tenantId: input.tenantId, ownerUid: input.ownerUid, planId, self: input.audit.self });
  return { tenantId: input.tenantId, ownerUid: input.ownerUid, created: true };
}

/**
 * Alta ADMIN (PLATFORM_ADMIN): resuelve/crea el owner por EMAIL y delega en el core.
 * El self-registro (registerTenantOwner) usa el core directo con el uid del caller.
 */
export async function provisionTenant(input: ProvisionTenantInput): Promise<ProvisionTenantResult> {
  if (!input.name || !input.ownerEmail) throw new Error('Faltan name y ownerEmail');
  const tenantId = slugify(input.slug || input.name);
  if (!tenantId) throw new Error('No se pudo derivar un slug válido del nombre');

  // Owner en Auth (crear o vincular por email) — solo el path admin resuelve por email.
  let ownerUid: string;
  try {
    ownerUid = (await auth().getUserByEmail(input.ownerEmail)).uid;
  } catch {
    const createArg: { email: string; displayName?: string; password?: string } = { email: input.ownerEmail };
    if (input.ownerName) createArg.displayName = input.ownerName;
    if (input.ownerPassword) createArg.password = input.ownerPassword;
    ownerUid = (await auth().createUser(createArg)).uid;
  }

  return provisionTenantCore({
    tenantId,
    businessName: input.name,
    ownerUid,
    ownerEmail: input.ownerEmail,
    ownerName: input.ownerName,
    planId: input.planId,
    industry: input.industry,
    country: input.country,
    currency: input.currency,
    phone: '',
    audit: { action: 'tenant.provisioned', actorRole: 'PLATFORM_ADMIN', self: false },
  });
}
