/**
 * aiReservation.test.ts — Reserva transaccional de cuota de IA (ADR-0018)
 * =======================================================================
 * Los 12 casos discriminantes del programa AI-USAGE-RESERVATION-AND-ALERTS-1. El doble de
 * Firestore es TRANSACCIONAL CON VERSIONES (calcado del de historyCoordinator.generaciones):
 * cada tx registra las versiones leídas y reintenta ante conflicto — la concurrencia acá es
 * real a nivel de contrato, no un mock secuencial. La concurrencia de procesos de verdad
 * (varios Node contra el emulador) la cubre verify-ai-reservation.mjs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Timestamp } from 'firebase-admin/firestore';

const docs = new Map<string, Record<string, unknown>>();
const versiones = new Map<string, number>();

interface Op { path: string; data: Record<string, unknown>; merge?: boolean; create?: boolean }

vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const auditorias: Array<Record<string, unknown>> = [];
vi.mock('../audit/audit.js', () => ({ recordAudit: async (e: Record<string, unknown>) => { auditorias.push(e); } }));

// Entitlements configurables por test (limite, posture, trial). Feature check espiado.
const entMock = {
  limits: { maxAiTokensPerMonth: 10_000 } as Record<string, number>,
  posture: { operational: true, premiumAllowed: true, reason: 'active' },
  trialExpired: false,
};
const assertFeatureEnabled = vi.fn(async () => undefined);
vi.mock('./entitlements.js', () => ({
  assertFeatureEnabled: (...a: unknown[]) => assertFeatureEnabled(...a),
  resolveEntitlements: async () => ({ ...entMock, tenantId: 't', limits: { ...entMock.limits } }),
}));
vi.mock('./usageReset.js', () => ({ maybeResetUsage: vi.fn(async () => false) }));

const escribir = (path: string, data: Record<string, unknown>, merge?: boolean): void => {
  docs.set(path, merge ? fusionar(docs.get(path) ?? {}, data) : { ...data });
  versiones.set(path, (versiones.get(path) ?? 0) + 1);
};
const esPlano = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Timestamp);
function fusionar(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const prev = out[k];
    if (esPlano(v) && Object.keys(v).length > 0 && esPlano(prev)) out[k] = fusionar(prev, v);
    else out[k] = esPlano(v) ? { ...v } : v;
  }
  return out;
}

class YaExiste extends Error { code = 6; }

const refDe = (path: string) => ({
  path,
  get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
  create: async (data: Record<string, unknown>) => {
    if (docs.has(path)) throw new YaExiste('already exists');
    escribir(path, data);
  },
  set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => escribir(path, data, opts?.merge),
});

type Cond = { f: string; op: string; v: unknown };
const cumple = (d: Record<string, unknown>, conds: Cond[]): boolean =>
  conds.every((c) => {
    const val = d[c.f];
    if (c.op === '==') return val === c.v;
    if (c.op === '<') return typeof val === 'number' && typeof c.v === 'number' && val < c.v;
    return false;
  });
const consulta = (matcher: (p: string) => boolean, conds: Cond[] = [], lim = Infinity) => ({
  where: (f: string, op: string, v: unknown) => consulta(matcher, [...conds, { f, op, v }], lim),
  limit: (n: number) => consulta(matcher, conds, n),
  get: async () => {
    const out: Array<{ ref: ReturnType<typeof refDe>; data: () => Record<string, unknown> }> = [];
    for (const [p, d] of docs) {
      if (!matcher(p)) continue;
      if (cumple(d, conds)) out.push({ ref: refDe(p), data: () => d });
      if (out.length >= lim) break;
    }
    return { docs: out, empty: out.length === 0, size: out.length };
  },
});
const coleccion = (base: string) =>
  consulta((p) => p.startsWith(base + '/') && !p.slice(base.length + 1).includes('/'));
const grupo = (nombre: string) =>
  consulta((p) => { const seg = p.split('/'); return seg.length >= 2 && seg[seg.length - 2] === nombre; });

vi.mock('../lib/firebase.js', () => ({
  db: () => ({
    doc: (path: string) => refDe(path),
    collection: (path: string) => coleccion(path),
    collectionGroup: (nombre: string) => grupo(nombre),
    runTransaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      for (let intento = 0; intento < 6; intento++) {
        const leidos = new Map<string, number>();
        const ops: Op[] = [];
        const tx = {
          get: async (ref: { path: string }) => {
            leidos.set(ref.path, versiones.get(ref.path) ?? 0);
            return { exists: docs.has(ref.path), data: () => docs.get(ref.path) };
          },
          set: (ref: { path: string }, data: Record<string, unknown>, opts?: { merge?: boolean }) =>
            ops.push({ path: ref.path, data, merge: opts?.merge }),
          create: (ref: { path: string }, data: Record<string, unknown>) => ops.push({ path: ref.path, data, create: true }),
          update: (ref: { path: string }, data: Record<string, unknown>) => ops.push({ path: ref.path, data, merge: true }),
        };
        const r: unknown = await fn(tx);
        const choco = [...leidos].some(([p, v]) => (versiones.get(p) ?? 0) !== v);
        if (choco) continue;
        for (const op of ops) {
          if (op.create && docs.has(op.path)) { throw new YaExiste('already exists'); }
          escribir(op.path, op.data, op.merge && !op.create);
        }
        return r;
      }
      throw new Error('transacción sin converger');
    },
  }),
  paths: {
    tenant: (t: string) => `tenants/${t}`,
    notifications: (t: string) => `tenants/${t}/notifications`,
    notification: (t: string, id: string) => `tenants/${t}/notifications/${id}`,
  },
}));

import {
  reservarTurnoDeIa,
  runAiReservationSweep,
  estimacionDeTokens,
  AI_RESERVATION_LEASE_MS,
  UMBRALES_ALERTA_IA,
  aiReservationPath,
} from './aiReservation.js';

const T = 'tnt_res';
const T2 = 'tnt_otro';
const NOW = 1_770_000_000_000;
const sembrarTenant = (t: string, usage: Record<string, unknown> = {}): void => {
  docs.set(`tenants/${t}`, {
    id: t, planId: 'starter',
    usage: { aiTokensThisMonth: 0, aiCostUsdThisMonth: 0, aiTokensReserved: 0, currentPeriodStart: Timestamp.fromMillis(NOW - 86_400_000), ...usage },
  });
};
const usageDe = (t: string) => (docs.get(`tenants/${t}`) as { usage: Record<string, number> }).usage;
const reservaDoc = (t: string, clave: string) => docs.get(aiReservationPath(t, clave));
const alertas = (t: string) => [...docs.keys()].filter((k) => k.startsWith(`tenants/${t}/notifications/`));

beforeEach(() => {
  docs.clear(); versiones.clear(); auditorias.length = 0; vi.clearAllMocks();
  entMock.limits = { maxAiTokensPerMonth: 10_000 };
  entMock.posture = { operational: true, premiumAllowed: true, reason: 'active' };
  entMock.trialExpired = false;
  sembrarTenant(T);
  sembrarTenant(T2);
});

describe('1. dos solicitudes con la misma clave', () => {
  it('secuencial: la segunda REUSA la reserva — un doc, el contador sube UNA vez', async () => {
    const a = await reservarTurnoDeIa(T, 'ventas-wamid1', 1500, { context: 'whatsapp_sales_agent', nowMs: NOW });
    const b = await reservarTurnoDeIa(T, 'ventas-wamid1', 1500, { context: 'whatsapp_sales_agent', nowMs: NOW });
    expect(a.cerrada).toBe(false);
    expect(b.cerrada).toBe(false);
    expect(usageDe(T).aiTokensReserved).toBe(1500);
    expect(reservaDoc(T, 'ventas-wamid1')).toMatchObject({ status: 'reservada', estimatedTokens: 1500 });
  });

  it('concurrente: Promise.all con la misma clave ⇒ una sola reserva', async () => {
    await Promise.all([
      reservarTurnoDeIa(T, 'ventas-w2', 1500, { context: 'whatsapp_sales_agent', nowMs: NOW }),
      reservarTurnoDeIa(T, 'ventas-w2', 1500, { context: 'whatsapp_sales_agent', nowMs: NOW }),
    ]);
    expect(usageDe(T).aiTokensReserved).toBe(1500);
  });

  it('handle REUSADO con estimación distinta: liquidar/liberar descuentan la del DOC, no la del closure (review MEDIO 1)', async () => {
    await reservarTurnoDeIa(T, 'ventas-drift', 2000, { context: 'whatsapp_sales_agent', nowMs: NOW });
    // Reintento con la misma clave pero estimación distinta (p. ej. cambió ESTIMACIONES entre deploys).
    const b = await reservarTurnoDeIa(T, 'ventas-drift', 500, { context: 'whatsapp_sales_agent', nowMs: NOW });
    expect(b.cerrada).toBe(false);
    expect(usageDe(T).aiTokensReserved).toBe(2000); // una sola reserva, la original
    await b.liquidar({ inputTokens: 100, outputTokens: 50 }, 0.001);
    // Si descontara el 500 del closure, quedarían 1500 fantasma PARA SIEMPRE.
    expect(usageDe(T).aiTokensReserved).toBe(0);
    expect(usageDe(T).aiTokensThisMonth).toBe(150);
  });

  it('clave ya LIQUIDADA ⇒ handle inerte (cerrada): no re-reserva ni re-factura', async () => {
    const a = await reservarTurnoDeIa(T, 'ventas-w3', 1000, { context: 'whatsapp_sales_agent', nowMs: NOW });
    await a.liquidar({ inputTokens: 400, outputTokens: 100 }, 0.01);
    const b = await reservarTurnoDeIa(T, 'ventas-w3', 1000, { context: 'whatsapp_sales_agent', nowMs: NOW });
    expect(b.cerrada).toBe(true);
    await b.liquidar({ inputTokens: 999, outputTokens: 999 }, 9); // inerte
    expect(usageDe(T).aiTokensThisMonth).toBe(500);
    expect(usageDe(T).aiTokensReserved).toBe(0);
  });
});

describe('2. múltiples reservas concurrentes cerca del límite', () => {
  it('el agregado JAMÁS excede el límite: con lugar para 2 de 5, entran exactamente 2', async () => {
    entMock.limits = { maxAiTokensPerMonth: 3_000 };
    const rs = await Promise.allSettled(
      [1, 2, 3, 4, 5].map((i) => reservarTurnoDeIa(T, `ventas-c${i}`, 1400, { context: 'whatsapp_sales_agent', nowMs: NOW })),
    );
    const ok = rs.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBe(2);
    expect(usageDe(T).aiTokensReserved).toBe(2_800);
    for (const r of rs) if (r.status === 'rejected') expect((r.reason as { code?: string }).code).toBe('resource-exhausted');
  });

  it('lo ya liquidado también cuenta: settled 9.000 + reserva 1.500 > 10.000 ⇒ rechaza', async () => {
    sembrarTenant(T, { aiTokensThisMonth: 9_000 });
    await expect(reservarTurnoDeIa(T, 'ventas-x', 1_500, { context: 'whatsapp_sales_agent', nowMs: NOW }))
      .rejects.toMatchObject({ code: 'resource-exhausted' });
    expect(reservaDoc(T, 'ventas-x')).toBeUndefined();
  });
});

describe('3. liquidación repetida', () => {
  it('cobra exactamente una vez y libera la diferencia estimado-vs-real', async () => {
    const r = await reservarTurnoDeIa(T, 'ventas-l1', 1500, { context: 'whatsapp_sales_agent', nowMs: NOW });
    const p1 = await r.liquidar({ inputTokens: 700, outputTokens: 200 }, 0.02);
    const p2 = await r.liquidar({ inputTokens: 700, outputTokens: 200 }, 0.02);
    expect(p1.aplicada).toBe(true);
    expect(p2.aplicada).toBe(false);
    expect(usageDe(T).aiTokensThisMonth).toBe(900);
    expect(usageDe(T).aiCostUsdThisMonth).toBeCloseTo(0.02);
    expect(usageDe(T).aiTokensReserved).toBe(0);
    expect(reservaDoc(T, 'ventas-l1')).toMatchObject({ status: 'liquidada', actualTokens: 900 });
  });
});

describe('4. error antes de llamar al proveedor ⇒ liberar', () => {
  it('devuelve la capacidad completa; liberar dos veces es inofensivo', async () => {
    const r = await reservarTurnoDeIa(T, 'ventas-e1', 1500, { context: 'whatsapp_sales_agent', nowMs: NOW });
    expect(usageDe(T).aiTokensReserved).toBe(1500);
    expect((await r.liberar('proveedor_no_configurado')).aplicada).toBe(true);
    expect((await r.liberar('proveedor_no_configurado')).aplicada).toBe(false);
    expect(usageDe(T).aiTokensReserved).toBe(0);
    expect(usageDe(T).aiTokensThisMonth).toBe(0);
    expect(reservaDoc(T, 'ventas-e1')).toMatchObject({ status: 'liberada' });
  });
});

describe('5. fallo después del proveedor pero antes de liquidar (resultado ambiguo)', () => {
  it('la reserva queda reservada (recuperable) y una liquidación tardía post-vencimiento NO cobra doble', async () => {
    const r = await reservarTurnoDeIa(T, 'ventas-a1', 1500, { context: 'whatsapp_sales_agent', nowMs: NOW });
    // el proceso murió acá: nadie liquidó. El barrido la vence pasado el lease…
    await runAiReservationSweep({ nowMs: NOW + AI_RESERVATION_LEASE_MS + 1 });
    expect(reservaDoc(T, 'ventas-a1')).toMatchObject({ status: 'vencida' });
    expect(usageDe(T).aiTokensReserved).toBe(0);
    // …y el proceso zombi que despierta y liquida tarde: no-op.
    expect((await r.liquidar({ inputTokens: 500, outputTokens: 100 }, 0.01)).aplicada).toBe(false);
    expect(usageDe(T).aiTokensThisMonth).toBe(0);
  });
});

describe('6. recuperación de reservas vencidas', () => {
  it('el barrido vence SOLO las expiradas; la recuperación lazy destraba una reserva nueva', async () => {
    await reservarTurnoDeIa(T, 'ventas-v1', 4000, { context: 'whatsapp_sales_agent', nowMs: NOW });
    await reservarTurnoDeIa(T, 'ventas-v2', 4000, { context: 'whatsapp_sales_agent', nowMs: NOW + AI_RESERVATION_LEASE_MS });
    entMock.limits = { maxAiTokensPerMonth: 10_000 };
    // v1 ya venció; v2 sigue viva. Sin barrido, 8.000 reservados no dejan entrar 4.000…
    // …pero la reserva hace recuperación lazy de v1 y entra.
    const r3 = await reservarTurnoDeIa(T, 'ventas-v3', 4000, { context: 'whatsapp_sales_agent', nowMs: NOW + AI_RESERVATION_LEASE_MS + 1 });
    expect(r3.cerrada).toBe(false);
    expect(reservaDoc(T, 'ventas-v1')).toMatchObject({ status: 'vencida' });
    expect(reservaDoc(T, 'ventas-v2')).toMatchObject({ status: 'reservada' });
    expect(usageDe(T).aiTokensReserved).toBe(8000); // v2 + v3
  });
});

describe('7. cambio de período mensual', () => {
  it('reserva del mes A liquidada en el mes B: lo real cae en B y el contador reservado hace clamp ≥ 0', async () => {
    const r = await reservarTurnoDeIa(T, 'ventas-p1', 1500, { context: 'whatsapp_sales_agent', nowMs: NOW });
    // El reset del período (lazy o scheduler) pisó usage COMPLETO — incluido un
    // aiTokensReserved que un reset viejo pudiera haber dejado en 0.
    escribir(`tenants/${T}`, { usage: { aiTokensThisMonth: 0, aiCostUsdThisMonth: 0, aiTokensReserved: 0, currentPeriodStart: Timestamp.fromMillis(NOW + 30 * 86_400_000) } }, true);
    const p = await r.liquidar({ inputTokens: 600, outputTokens: 100 }, 0.015);
    expect(p.aplicada).toBe(true);
    expect(usageDe(T).aiTokensThisMonth).toBe(700); // cae en el período nuevo
    expect(usageDe(T).aiTokensReserved).toBe(0); // clamp: jamás negativo
  });
});

describe('8. cambio de plan durante una reserva', () => {
  it('el límite nuevo aplica a reservas NUEVAS; la reserva en vuelo liquida normal', async () => {
    const r = await reservarTurnoDeIa(T, 'ventas-pl1', 4000, { context: 'whatsapp_sales_agent', nowMs: NOW });
    entMock.limits = { maxAiTokensPerMonth: 3_000 }; // downgrade en el medio
    const p = await r.liquidar({ inputTokens: 3_500, outputTokens: 300 }, 0.05);
    expect(p.aplicada).toBe(true);
    expect(usageDe(T).aiTokensThisMonth).toBe(3_800);
    await expect(reservarTurnoDeIa(T, 'ventas-pl2', 1000, { context: 'whatsapp_sales_agent', nowMs: NOW }))
      .rejects.toMatchObject({ code: 'resource-exhausted' });
  });
});

describe('9. alerta única por tenant/período/umbral', () => {
  it('cruzar 70/85/95 emite UNA campana por umbral aunque se liquide muchas veces', async () => {
    entMock.limits = { maxAiTokensPerMonth: 1_000 };
    for (let i = 0; i < 4; i++) {
      const r = await reservarTurnoDeIa(T, `ventas-u${i}`, 200, { context: 'whatsapp_sales_agent', nowMs: NOW });
      await r.liquidar({ inputTokens: 200, outputTokens: 0 }, 0.001);
    }
    // 800/1000 = 80% ⇒ solo el umbral 70 disparó, una vez.
    const a = alertas(T);
    expect(a).toHaveLength(1);
    expect(a[0]).toContain('ai-quota-');
    expect(a[0]).toContain('-70');
    const r5 = await reservarTurnoDeIa(T, 'ventas-u5', 190, { context: 'whatsapp_sales_agent', nowMs: NOW });
    await r5.liquidar({ inputTokens: 190, outputTokens: 0 }, 0.001); // 990/1000 = 99% ⇒ 85 y 95
    expect(alertas(T)).toHaveLength(3);
  });

  it('el bloqueo por agotamiento emite la alerta `agotada` una sola vez', async () => {
    entMock.limits = { maxAiTokensPerMonth: 1_000 };
    sembrarTenant(T, { aiTokensThisMonth: 1_000 });
    for (let i = 0; i < 2; i++) {
      await expect(reservarTurnoDeIa(T, `ventas-b${i}`, 500, { context: 'whatsapp_sales_agent', nowMs: NOW }))
        .rejects.toMatchObject({ code: 'resource-exhausted' });
    }
    const agotadas = alertas(T).filter((k) => k.endsWith('-100'));
    expect(agotadas).toHaveLength(1);
    const doc = docs.get(agotadas[0]);
    expect(doc).toMatchObject({ category: 'ai_quota', type: 'ai_quota_agotada', read: false });
  });

  it('ilimitado (enterprise) jamás alerta', async () => {
    entMock.limits = { maxAiTokensPerMonth: 1_000_000_000 };
    const r = await reservarTurnoDeIa(T, 'ventas-inf', 500_000, { context: 'whatsapp_sales_agent', nowMs: NOW });
    await r.liquidar({ inputTokens: 400_000, outputTokens: 50_000 }, 1.5);
    expect(alertas(T)).toHaveLength(0);
  });
});

describe('10. aislamiento entre tenants', () => {
  it('agotar T no toca a T2, y las claves iguales viven en documentos separados', async () => {
    entMock.limits = { maxAiTokensPerMonth: 1_000 };
    sembrarTenant(T, { aiTokensThisMonth: 1_000 });
    await expect(reservarTurnoDeIa(T, 'ventas-k', 500, { context: 'whatsapp_sales_agent', nowMs: NOW }))
      .rejects.toMatchObject({ code: 'resource-exhausted' });
    const r2 = await reservarTurnoDeIa(T2, 'ventas-k', 500, { context: 'whatsapp_sales_agent', nowMs: NOW });
    expect(r2.cerrada).toBe(false);
    expect(usageDe(T2).aiTokensReserved).toBe(500);
    expect(usageDe(T).aiTokensReserved).toBe(0);
    expect(alertas(T2)).toHaveLength(0);
  });
});

describe('11. ausencia de prompts, PII y secretos', () => {
  it('la reserva y la alerta persisten SOLO metadata operativa (whitelist de campos)', async () => {
    entMock.limits = { maxAiTokensPerMonth: 1_000 };
    const r = await reservarTurnoDeIa(T, 'ventas-meta', 800, { context: 'whatsapp_sales_agent', nowMs: NOW });
    await r.liquidar({ inputTokens: 700, outputTokens: 100 }, 0.02);
    const res = reservaDoc(T, 'ventas-meta')!;
    const permitidos = ['id', 'tenantId', 'context', 'status', 'estimatedTokens', 'actualTokens', 'costUsd', 'periodStartMs', 'reservedAt', 'expiresAt', 'settledAt', 'releasedAt', 'expiredAt', 'motivo'];
    for (const k of Object.keys(res)) expect(permitidos).toContain(k);
    const alerta = docs.get(alertas(T)[0]!)!;
    const texto = JSON.stringify(alerta);
    expect(texto).not.toMatch(/prompt|message|telefono|\+595|Bearer|sk-/i);
    const alertaPermitidos = ['id', 'tenantId', 'category', 'type', 'title', 'body', 'dedupeKey', 'read', 'readAt', 'createdAt'];
    for (const k of Object.keys(alerta)) expect(alertaPermitidos).toContain(k);
  });
});

describe('contratos de compatibilidad del gate (caso 12 se completa en salesAgent/internalAssistant)', () => {
  it('suspensión y trial vencido lanzan failed-precondition SIN crear reserva', async () => {
    entMock.posture = { operational: false, premiumAllowed: false, reason: 'canceled' };
    await expect(reservarTurnoDeIa(T, 'ventas-s', 100, { context: 'whatsapp_sales_agent', nowMs: NOW }))
      .rejects.toMatchObject({ code: 'failed-precondition' });
    entMock.posture = { operational: true, premiumAllowed: true, reason: 'active' };
    entMock.trialExpired = true;
    await expect(reservarTurnoDeIa(T, 'ventas-t', 100, { context: 'whatsapp_sales_agent', nowMs: NOW }))
      .rejects.toMatchObject({ code: 'failed-precondition' });
    expect(reservaDoc(T, 'ventas-s')).toBeUndefined();
    expect(reservaDoc(T, 'ventas-t')).toBeUndefined();
    expect(usageDe(T).aiTokensReserved).toBe(0);
  });

  it('los bloqueos auditan entitlement.blocked, como el gate anterior', async () => {
    entMock.limits = { maxAiTokensPerMonth: 100 };
    await expect(reservarTurnoDeIa(T, 'ventas-au', 500, { context: 'whatsapp_sales_agent', nowMs: NOW }))
      .rejects.toMatchObject({ code: 'resource-exhausted' });
    expect(auditorias.some((a) => a['action'] === 'entitlement.blocked')).toBe(true);
  });

  it('estimaciones centralizadas: texto hoy, imagen declarada SIN consumidor', () => {
    expect(estimacionDeTokens('texto_ventas')).toBe(1500);
    expect(estimacionDeTokens('texto_interno')).toBe(1500);
    expect(estimacionDeTokens('imagen_vision')).toBeGreaterThan(1500);
    expect(UMBRALES_ALERTA_IA).toEqual([70, 85, 95, 100]);
  });
});
