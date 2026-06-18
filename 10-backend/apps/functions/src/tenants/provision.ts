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

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);

const WELCOME_BY_INDUSTRY: Record<string, string> = {
  perfumeria: '¡Hola! 💖 Bienvenida. Soy tu asesora de fragancias. ¿Buscás algo para vos o para regalar?',
  indumentaria: '¡Hola! 👗 Bienvenida. ¿Qué estás buscando hoy? Te ayudo a encontrar tu prenda ideal.',
  cosmetica: '¡Hola! ✨ Bienvenida. ¿Buscás algo en particular o querés que te recomiende?',
  default: '¡Hola! 👋 Gracias por escribirnos. ¿En qué te puedo ayudar?',
};

export async function provisionTenant(input: ProvisionTenantInput): Promise<ProvisionTenantResult> {
  if (!input.name || !input.ownerEmail) throw new Error('Faltan name y ownerEmail');
  const tenantId = slugify(input.slug || input.name);
  if (!tenantId) throw new Error('No se pudo derivar un slug válido del nombre');

  const tenantRef = db().doc(paths.tenant(tenantId));
  const existing = await tenantRef.get();
  if (existing.exists && existing.data()?.contact) {
    throw new Error(`La empresa "${tenantId}" ya existe`);
  }

  await ensurePlansSeeded();
  const planId = input.planId ?? 'free';
  const plan = await getPlan(planId);
  if (!plan) throw new Error(`Plan inválido: ${planId}`);

  const now = Timestamp.now();
  const welcome = WELCOME_BY_INDUSTRY[input.industry ?? 'default'] ?? WELCOME_BY_INDUSTRY.default;

  // 1) Usuario owner en Auth (crear o vincular por email) + custom claims.
  let ownerUid: string;
  try {
    ownerUid = (await auth().getUserByEmail(input.ownerEmail)).uid;
  } catch {
    const createArg: { email: string; displayName?: string; password?: string } = { email: input.ownerEmail };
    if (input.ownerName) createArg.displayName = input.ownerName;
    if (input.ownerPassword) createArg.password = input.ownerPassword;
    ownerUid = (await auth().createUser(createArg)).uid;
  }
  await auth().setCustomUserClaims(ownerUid, { tenantId, role: 'TENANT_OWNER' as UserRole });

  // 2) Tenant doc con plan / límites / uso / estado.
  await tenantRef.set(
    {
      id: tenantId,
      name: input.name,
      slug: tenantId,
      status: 'ACTIVE' as TenantStatus,
      planId,
      contact: { ownerName: input.ownerName ?? '', email: input.ownerEmail, phone: '', country: input.country ?? 'PY' },
      branding: { businessName: input.name, welcomeMessage: welcome, currency: input.currency ?? 'PYG', timezone: 'America/Asuncion', locale: 'es-PY' },
      limits: plan.limits,
      usage: { ordersThisMonth: 0, messagesThisMonth: 0, currentPeriodStart: now },
      subscription: { status: 'none', planId, stripeCustomerId: null, stripeSubscriptionId: null, currentPeriodEnd: null, updatedAt: now },
      industry: input.industry ?? null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    { merge: true },
  );

  // 3) Doc del usuario owner.
  await db().doc(paths.user(ownerUid)).set(
    { id: ownerUid, email: input.ownerEmail, name: input.ownerName ?? '', role: 'TENANT_OWNER', tenantId, status: 'ACTIVE', updatedAt: now },
    { merge: true },
  );

  // 4) Config inicial del agente (saludo por rubro). El catálogo se carga desde /onboarding.
  await db().doc(`tenants/${tenantId}/config/agent`).set(
    { agentName: 'Asistente', businessName: input.name, greetingMessage: welcome, botEnabled: true, profitMode: false, industry: input.industry ?? '', updatedAt: now },
    { merge: true },
  );

  logger.info('Empresa aprovisionada', { tenantId, ownerUid, planId });
  return { tenantId, ownerUid, created: !existing.exists };
}
