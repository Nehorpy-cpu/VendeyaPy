/**
 * config/validate.ts — Validación ESTRICTA de payloads de config del tenant (Fase 5C-A)
 * =====================================================================================
 * Funciones PURAS (testeables) que validan y SANITIZAN (whitelist de campos) los payloads de
 * config/agent, config/checkout y config/channels. Lanzan Error con mensaje claro ante datos
 * inválidos; devuelven SOLO los campos permitidos (el callable nunca escribe fuera de su scope).
 */
import type { BankAccount, Seller, WhatsappSendMode } from '@vpw/shared';

const MAX_TEXT = 5000;

function asObject(v: unknown, label = 'estructura'): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${label} inválida.`);
  return v as Record<string, unknown>;
}
function reqStr(v: unknown, field: string, max = 500): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`Campo "${field}" requerido (texto).`);
  if (v.length > max) throw new Error(`Campo "${field}" demasiado largo.`);
  return v;
}
function optStr(v: unknown, field: string, max = 500): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new Error(`Campo "${field}" debe ser texto.`);
  if (v.length > max) throw new Error(`Campo "${field}" demasiado largo.`);
  return v;
}
function asBool(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean') throw new Error(`Campo "${field}" debe ser booleano.`);
  return v;
}
function asArray<T>(v: unknown, max: number, label: string, map: (it: unknown, i: number) => T): T[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error(`"${label}" debe ser una lista.`);
  if (v.length > max) throw new Error(`"${label}" supera el máximo (${max}).`);
  return v.map(map);
}

// ---------------- config/agent ----------------

const AGENT_STR_KEYS = ['agentName', 'businessName', 'tone', 'language', 'greetingMessage', 'farewellMessage', 'fallbackMessage', 'handoffMessage', 'salesRules', 'industry'] as const;
const AGENT_BOOL_KEYS = ['botEnabled', 'testMode', 'profitMode'] as const;

/** Devuelve un patch sanitizado de AgentConfig (solo campos permitidos). Lanza si es inválido. */
export function validateAgentConfigPatch(data: unknown): Record<string, unknown> {
  const d = asObject(data, 'config de agente');
  const out: Record<string, unknown> = {};
  for (const k of AGENT_STR_KEYS) {
    if (d[k] === undefined) continue;
    if (typeof d[k] !== 'string') throw new Error(`Campo "${k}" debe ser texto.`);
    if ((d[k] as string).length > MAX_TEXT) throw new Error(`Campo "${k}" demasiado largo.`);
    out[k] = d[k];
  }
  for (const k of AGENT_BOOL_KEYS) {
    if (d[k] === undefined) continue;
    out[k] = asBool(d[k], k);
  }
  if (d.faq !== undefined) {
    out.faq = asArray(d.faq, 100, 'faq', (it) => {
      const f = asObject(it, 'faq');
      return { q: reqStr(f.q, 'faq.q', 1000), a: reqStr(f.a, 'faq.a', 2000) };
    });
  }
  if (Object.keys(out).length === 0) throw new Error('No hay campos válidos para actualizar.');
  return out;
}

// ---------------- config/checkout ----------------

export function validateCheckoutConfig(data: unknown): { bankAccounts: BankAccount[]; sellers: Seller[] } {
  const d = asObject(data, 'config de checkout');
  const bankAccounts = asArray<BankAccount>(d.bankAccounts, 50, 'bankAccounts', (it) => {
    const b = asObject(it, 'cuenta bancaria');
    const acc: BankAccount = {
      bank: reqStr(b.bank, 'bank'),
      accountNumber: reqStr(b.accountNumber, 'accountNumber'),
      holder: reqStr(b.holder, 'holder'),
      document: reqStr(b.document, 'document'),
    };
    const alias = optStr(b.alias, 'alias');
    if (alias !== undefined) acc.alias = alias;
    return acc;
  });
  const sellers = asArray<Seller>(d.sellers, 100, 'sellers', (it) => {
    const s = asObject(it, 'vendedor');
    return { name: reqStr(s.name, 'name'), whatsapp: reqStr(s.whatsapp, 'whatsapp'), active: asBool(s.active, 'active') };
  });
  return { bankAccounts, sellers };
}

// ---------------- config/channels ----------------

export function validateChannelConfig(data: unknown): { whatsappSendMode: WhatsappSendMode } {
  const d = asObject(data, 'config de canales');
  const m = d.whatsappSendMode;
  if (m !== 'mock' && m !== 'live') throw new Error("Campo \"whatsappSendMode\" debe ser 'mock' o 'live'.");
  return { whatsappSendMode: m };
}
