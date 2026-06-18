/**
 * meta/graphClient.ts — Cliente de Graph API inyectable (Fase 4B)
 * ==============================================================
 * TODAS las llamadas a Graph pasan por esta interfaz. En producción usa HTTP real;
 * en emulador/tests se usa un fake (FixtureMetaGraphClient) que lee respuestas canned
 * desde `metaTestFixtures/graph` (NUNCA llama a graph.facebook.com). Los parsers son
 * puros y testeables. El token/code NUNCA se loguean.
 */
import axios from 'axios';
import { db } from '../lib/firebase.js';

const GRAPH = 'https://graph.facebook.com/v19.0';

export interface MetaPhoneNumber {
  id: string; // phone_number_id
  displayPhoneNumber: string;
  verifiedName: string;
  qualityRating: string;
  codeVerificationStatus: string;
}

export interface DebugTokenResult {
  isValid: boolean;
  scopes: string[];
  wabaIds: string[]; // de granular_scopes (whatsapp_business_*)
  expiresAtMs: number | null; // null = sin expiración (token de System User)
}

export interface ExchangeResult {
  accessToken: string;
  tokenType: string;
  expiresInSec: number | null;
}

export interface MetaGraphClient {
  exchangeCode(code: string): Promise<ExchangeResult>;
  debugToken(accessToken: string): Promise<DebugTokenResult>;
  listWabaPhoneNumbers(wabaId: string, accessToken: string): Promise<MetaPhoneNumber[]>;
  getPhoneNumber(phoneNumberId: string, accessToken: string): Promise<MetaPhoneNumber | null>;
  subscribeApp(wabaId: string, accessToken: string): Promise<void>;
}

// ---------------- Parsers PUROS (testeables sin red) ----------------

export function parseDebugToken(payload: unknown): DebugTokenResult {
  const d = ((payload as { data?: Record<string, unknown> } | null)?.data ?? {}) as Record<string, unknown>;
  const granular = Array.isArray(d.granular_scopes) ? (d.granular_scopes as Array<{ scope?: string; target_ids?: unknown }>) : [];
  const wabaIds = [
    ...new Set(
      granular
        .filter((g) => typeof g?.scope === 'string' && g.scope.includes('whatsapp_business') && Array.isArray(g.target_ids))
        .flatMap((g) => (g.target_ids as unknown[]).map(String)),
    ),
  ];
  const expiresAt = typeof d.expires_at === 'number' ? d.expires_at : 0;
  return {
    isValid: d.is_valid === true,
    scopes: Array.isArray(d.scopes) ? (d.scopes as unknown[]).map(String) : [],
    wabaIds,
    expiresAtMs: expiresAt > 0 ? expiresAt * 1000 : null,
  };
}

export function parsePhoneNumbers(payload: unknown): MetaPhoneNumber[] {
  const arr = Array.isArray((payload as { data?: unknown } | null)?.data) ? ((payload as { data: unknown[] }).data) : [];
  return arr.map((raw) => {
    const p = (raw ?? {}) as Record<string, unknown>;
    return {
      id: String(p.id ?? ''),
      displayPhoneNumber: String(p.display_phone_number ?? ''),
      verifiedName: String(p.verified_name ?? ''),
      qualityRating: String(p.quality_rating ?? ''),
      codeVerificationStatus: String(p.code_verification_status ?? ''),
    };
  }).filter((p) => p.id);
}

// ---------------- Implementación HTTP real ----------------

function appAccessToken(): string {
  const id = process.env.META_APP_ID;
  const secret = process.env.META_APP_SECRET;
  if (!id || !secret) throw new Error('Meta OAuth no configurado (META_APP_ID / META_APP_SECRET).');
  return `${id}|${secret}`;
}

export class HttpMetaGraphClient implements MetaGraphClient {
  async exchangeCode(code: string): Promise<ExchangeResult> {
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    const redirect = process.env.META_OAUTH_REDIRECT_URI;
    if (!appId || !appSecret) throw new Error('Meta OAuth no configurado (META_APP_ID / META_APP_SECRET).');
    const res = await axios.get(`${GRAPH}/oauth/access_token`, {
      params: { client_id: appId, client_secret: appSecret, code, ...(redirect ? { redirect_uri: redirect } : {}) },
      timeout: 10_000,
    });
    return {
      accessToken: res.data?.access_token,
      tokenType: res.data?.token_type ?? 'bearer',
      expiresInSec: res.data?.expires_in ?? null,
    };
  }

  async debugToken(accessToken: string): Promise<DebugTokenResult> {
    const res = await axios.get(`${GRAPH}/debug_token`, {
      params: { input_token: accessToken, access_token: appAccessToken() },
      timeout: 10_000,
    });
    return parseDebugToken(res.data);
  }

  async listWabaPhoneNumbers(wabaId: string, accessToken: string): Promise<MetaPhoneNumber[]> {
    const res = await axios.get(`${GRAPH}/${wabaId}/phone_numbers`, {
      params: { fields: 'id,display_phone_number,verified_name,quality_rating,code_verification_status' },
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 10_000,
    });
    return parsePhoneNumbers(res.data);
  }

  async getPhoneNumber(phoneNumberId: string, accessToken: string): Promise<MetaPhoneNumber | null> {
    const res = await axios.get(`${GRAPH}/${phoneNumberId}`, {
      params: { fields: 'id,display_phone_number,verified_name,quality_rating,code_verification_status' },
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 10_000,
    });
    const list = parsePhoneNumbers({ data: [res.data] });
    return list[0] ?? null;
  }

  async subscribeApp(wabaId: string, accessToken: string): Promise<void> {
    await axios.post(`${GRAPH}/${wabaId}/subscribed_apps`, null, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 10_000,
    });
  }
}

// ---------------- Fake por fixtures (emulador / e2e) ----------------

interface GraphFixture {
  exchangeError?: boolean;
  accessToken?: string;
  expiresInSec?: number | null;
  isValid?: boolean;
  scopes?: string[];
  wabaIds?: string[];
  tokenExpiresAtMs?: number | null;
  phoneNumbers?: MetaPhoneNumber[];
}

export class FixtureMetaGraphClient implements MetaGraphClient {
  constructor(private readonly fx: GraphFixture) {}

  async exchangeCode(_code: string): Promise<ExchangeResult> {
    if (this.fx.exchangeError) throw new Error('fixture: exchange falló');
    return { accessToken: this.fx.accessToken ?? 'fixture-token', tokenType: 'bearer', expiresInSec: this.fx.expiresInSec ?? null };
  }
  async debugToken(_accessToken: string): Promise<DebugTokenResult> {
    return {
      isValid: this.fx.isValid ?? true,
      scopes: this.fx.scopes ?? ['whatsapp_business_messaging', 'whatsapp_business_management'],
      wabaIds: this.fx.wabaIds ?? [],
      expiresAtMs: this.fx.tokenExpiresAtMs ?? null,
    };
  }
  async listWabaPhoneNumbers(_wabaId: string, _accessToken: string): Promise<MetaPhoneNumber[]> {
    return this.fx.phoneNumbers ?? [];
  }
  async getPhoneNumber(phoneNumberId: string, _accessToken: string): Promise<MetaPhoneNumber | null> {
    return (this.fx.phoneNumbers ?? []).find((p) => p.id === phoneNumberId) ?? null;
  }
  async subscribeApp(_wabaId: string, _accessToken: string): Promise<void> {
    /* no-op en fixture */
  }
}

const isEmulator = () => process.env.FUNCTIONS_EMULATOR === 'true';

/** Cliente activo: en emulador, fake leído de metaTestFixtures/graph; en prod, HTTP real. */
export async function getMetaGraphClient(): Promise<MetaGraphClient> {
  if (isEmulator()) {
    const fx = (await db().doc('metaTestFixtures/graph').get()).data() as GraphFixture | undefined;
    return new FixtureMetaGraphClient(fx ?? {});
  }
  return new HttpMetaGraphClient();
}
