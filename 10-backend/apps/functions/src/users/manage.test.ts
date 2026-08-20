/**
 * manage.test.ts — H-02: nadie secuestra la autorización de un usuario ajeno
 * ==========================================================================
 * Defecto auditado (`docs/system-audit-2026-08.md` §H-02): `inviteUser` resolvía el uid por email
 * y escribía `setCustomUserClaims(uid, { tenantId, role })` sobre un usuario que YA existía y
 * pertenecía a otra empresa, sin validar nada. Y `assertSameTenant` era fail-open: sin
 * `users/{uid}` no lanzaba — justo el caso del PLATFORM_ADMIN, cuyo bootstrap NO crea ese
 * documento a propósito. Resultado: el owner de A se llevaba al owner de B a su empresa, degradaba
 * al admin de plataforma a rol de tenant, y con `setUserActive` le deshabilitaba la cuenta.
 *
 * Lo que fija esta suite:
 *  · el destino ajeno se rechaza SIN escribir nada (claims de la víctima intactos);
 *  · el rechazo es UNIFORME (anti-enumeración): "de otra empresa", "desactivado" y
 *    "es PLATFORM_ADMIN" devuelven el mismo mensaje, porque el callable reenvía `e.message`;
 *  · los TRES flujos legítimos siguen intactos: email nuevo ⇒ se crea; usuario propio ⇒ se
 *    actualiza; PLATFORM_ADMIN ⇒ sigue operando sobre cualquier empresa.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Auth + Firestore de mentira: registran QUÉ se escribió, que es lo que el defecto rompía. */
const fake = vi.hoisted(() => {
  const usuariosPorEmail = new Map<string, { uid: string; claims?: Record<string, unknown>; disabled?: boolean }>();
  const usuariosPorUid = new Map<string, { uid: string; claims?: Record<string, unknown>; disabled?: boolean }>();
  const docs = new Map<string, Record<string, unknown>>();
  const claimsEscritos: Array<{ uid: string; claims: Record<string, unknown> }> = [];
  const docsEscritos: Array<{ path: string; data: Record<string, unknown> }> = [];
  const authUpdates: Array<{ uid: string; patch: Record<string, unknown> }> = [];
  let creados = 0;

  const sembrarUsuario = (uid: string, email: string, claims?: Record<string, unknown>) => {
    const u = { uid, claims };
    usuariosPorEmail.set(email, u);
    usuariosPorUid.set(uid, u);
  };
  const sembrarDoc = (uid: string, data: Record<string, unknown>) => docs.set(`users/${uid}`, data);

  const auth = () => ({
    getUserByEmail: async (email: string) => {
      const u = usuariosPorEmail.get(email);
      if (!u) throw Object.assign(new Error('user not found'), { code: 'auth/user-not-found' });
      return u;
    },
    getUser: async (uid: string) => {
      const u = usuariosPorUid.get(uid);
      if (!u) throw Object.assign(new Error('user not found'), { code: 'auth/user-not-found' });
      // El SDK de Admin expone los claims como `customClaims` — el fake tiene que hablar el
      // mismo idioma que el runtime real, o el guard leería `undefined` y "pasaría" en el test.
      return { uid: u.uid, customClaims: u.claims, disabled: u.disabled };
    },
    createUser: async ({ email }: { email: string }) => {
      const uid = `uid_nuevo_${++creados}`;
      sembrarUsuario(uid, email);
      return { uid };
    },
    setCustomUserClaims: async (uid: string, claims: Record<string, unknown>) => {
      claimsEscritos.push({ uid, claims });
      const u = usuariosPorUid.get(uid);
      if (u) u.claims = claims;
    },
    updateUser: async (uid: string, patch: Record<string, unknown>) => {
      authUpdates.push({ uid, patch });
      const u = usuariosPorUid.get(uid);
      if (u) u.disabled = patch['disabled'] as boolean;
    },
  });

  const db = () => ({
    doc: (path: string) => ({
      get: async () => ({ exists: docs.has(path), data: () => docs.get(path) }),
      set: async (data: Record<string, unknown>) => {
        docsEscritos.push({ path, data });
        docs.set(path, { ...(docs.get(path) ?? {}), ...data });
      },
    }),
  });

  return {
    auth, db, docs, claimsEscritos, docsEscritos, authUpdates, usuariosPorUid,
    sembrarUsuario, sembrarDoc,
    reset: () => {
      usuariosPorEmail.clear(); usuariosPorUid.clear(); docs.clear();
      claimsEscritos.length = 0; docsEscritos.length = 0; authUpdates.length = 0; creados = 0;
    },
  };
});

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock('../lib/firebase.js', () => ({
  db: fake.db,
  auth: fake.auth,
  paths: { user: (uid: string) => `users/${uid}` },
}));
vi.mock('../lib/logger.js', () => ({ logger: log }));

import { inviteUser, setUserRole, setUserActive } from './manage.js';

const EMPRESA_A = 'tnt-atacante';
const EMPRESA_B = 'tnt-victima';
const EMAIL_VICTIMA = 'owner@victima.com';
const UID_VICTIMA = 'uid_owner_victima';
const EMAIL_ADMIN = 'admin@plataforma.com';
const UID_ADMIN = 'uid_admin_plataforma';

/** Owner de OTRA empresa: existe en Auth y su doc declara el tenant ajeno. */
const sembrarVictima = () => {
  fake.sembrarUsuario(UID_VICTIMA, EMAIL_VICTIMA, { tenantId: EMPRESA_B, role: 'TENANT_OWNER' });
  fake.sembrarDoc(UID_VICTIMA, { id: UID_VICTIMA, tenantId: EMPRESA_B, role: 'TENANT_OWNER', status: 'ACTIVE' });
};

/**
 * PLATFORM_ADMIN: claims SIN tenantId y **sin documento** `users/{uid}` — el bootstrap
 * (`bootstrap-platform-admin.mjs:117`) lo deja así a propósito. Es el caso que el guard
 * fail-open dejaba pasar.
 */
const sembrarAdmin = () => fake.sembrarUsuario(UID_ADMIN, EMAIL_ADMIN, { role: 'PLATFORM_ADMIN' });

beforeEach(() => { fake.reset(); vi.clearAllMocks(); });

describe('H-02 · el destino ajeno no se puede secuestrar', () => {
  it('invitar al OWNER de otra empresa: rechazado, sin tocar sus claims ni su doc', async () => {
    sembrarVictima();
    await expect(inviteUser(EMPRESA_A, EMAIL_VICTIMA, 'SELLER')).rejects.toThrow();
    expect(fake.claimsEscritos).toHaveLength(0);
    expect(fake.docsEscritos).toHaveLength(0);
    // La víctima sigue siendo owner de SU empresa.
    expect(fake.usuariosPorUid.get(UID_VICTIMA)!.claims).toEqual({ tenantId: EMPRESA_B, role: 'TENANT_OWNER' });
  });

  it('invitar al PLATFORM_ADMIN (sin doc `users/{uid}`): rechazado, claims intactos', async () => {
    sembrarAdmin();
    await expect(inviteUser(EMPRESA_A, EMAIL_ADMIN, 'TENANT_VIEWER')).rejects.toThrow();
    expect(fake.claimsEscritos).toHaveLength(0);
    expect(fake.usuariosPorUid.get(UID_ADMIN)!.claims).toEqual({ role: 'PLATFORM_ADMIN' });
  });

  it('setUserActive sobre el PLATFORM_ADMIN: rechazado, la cuenta NO se deshabilita', async () => {
    sembrarAdmin();
    await expect(setUserActive(EMPRESA_A, UID_ADMIN, false)).rejects.toThrow();
    expect(fake.authUpdates).toHaveLength(0);
    expect(fake.usuariosPorUid.get(UID_ADMIN)!.disabled).toBeUndefined();
  });

  it('setUserRole sobre un usuario de otra empresa: rechazado sin escrituras', async () => {
    sembrarVictima();
    await expect(setUserRole(EMPRESA_A, UID_VICTIMA, 'SELLER')).rejects.toThrow();
    expect(fake.claimsEscritos).toHaveLength(0);
    expect(fake.docsEscritos).toHaveLength(0);
  });

  it('un usuario DESACTIVADO del propio tenant tampoco se reactiva por invitación', async () => {
    fake.sembrarUsuario('uid_baja', 'baja@miempresa.com', { tenantId: EMPRESA_A, role: 'SELLER' });
    fake.sembrarDoc('uid_baja', { id: 'uid_baja', tenantId: EMPRESA_A, role: 'SELLER', status: 'DISABLED' });
    await expect(inviteUser(EMPRESA_A, 'baja@miempresa.com', 'SELLER')).rejects.toThrow();
    expect(fake.claimsEscritos).toHaveLength(0);
  });

  it('una cuenta HUÉRFANA de Auth (registro sin aprovisionar) NO es adoptable', async () => {
    // Endurecido por la review del fix: el registro crea la cuenta ANTES de verificar el mail,
    // así que toda persona entre "me registré" y "verifiqué" quedaría adoptable por cualquier
    // owner que supiera su email — el mismo secuestro con otras víctimas.
    fake.sembrarUsuario('uid_huerfano', 'huerfano@ajeno.com');
    await expect(inviteUser(EMPRESA_A, 'huerfano@ajeno.com', 'SELLER')).rejects.toThrow();
    expect(fake.claimsEscritos).toHaveLength(0);
    expect(fake.docsEscritos).toHaveLength(0);
  });

  it('claims de OTRA empresa sin doc: rechazado (el doc borrado no reabre el secuestro)', async () => {
    fake.sembrarUsuario('uid_sin_doc', 'sindoc@otra.com', { tenantId: EMPRESA_B, role: 'SELLER' });
    await expect(inviteUser(EMPRESA_A, 'sindoc@otra.com', 'SELLER')).rejects.toThrow();
    expect(fake.claimsEscritos).toHaveLength(0);
  });

  it('un uid que no existe en Auth se rechaza (fail-closed, mismo mensaje)', async () => {
    await expect(setUserRole(EMPRESA_A, 'uid_que_no_existe', 'SELLER')).rejects.toThrow();
    expect(fake.claimsEscritos).toHaveLength(0);
  });

  it('ANTI-ENUMERACIÓN: los tres rechazos devuelven el MISMO mensaje', async () => {
    sembrarVictima();
    sembrarAdmin();
    fake.sembrarUsuario('uid_baja', 'baja@miempresa.com', { tenantId: EMPRESA_A, role: 'SELLER' });
    fake.sembrarDoc('uid_baja', { id: 'uid_baja', tenantId: EMPRESA_A, role: 'SELLER', status: 'DISABLED' });

    const mensajes = await Promise.all(
      [EMAIL_VICTIMA, EMAIL_ADMIN, 'baja@miempresa.com'].map((email) =>
        inviteUser(EMPRESA_A, email, 'SELLER').then(() => 'NO RECHAZÓ', (e: Error) => e.message),
      ),
    );
    expect(new Set(mensajes).size).toBe(1); // un solo mensaje para los tres casos
    expect(mensajes[0]).not.toContain(EMPRESA_B); // y no revela el tenant ajeno
  });
});

describe('H-02 · los flujos legítimos siguen intactos (no regresión)', () => {
  it('invitar a un email NUEVO: se crea el usuario y se le setean claims, como siempre', async () => {
    const r = await inviteUser(EMPRESA_A, 'nueva@miempresa.com', 'SELLER', 'Vendedora Nueva');
    expect(r.created).toBe(true);
    expect(fake.claimsEscritos).toEqual([{ uid: r.uid, claims: { tenantId: EMPRESA_A, role: 'SELLER' } }]);
    expect(fake.docs.get(`users/${r.uid}`)).toMatchObject({ tenantId: EMPRESA_A, role: 'SELLER', status: 'ACTIVE' });
  });

  it('re-invitar a alguien de MI empresa: se actualiza (no se duplica ni se rechaza)', async () => {
    fake.sembrarUsuario('uid_propio', 'propio@miempresa.com', { tenantId: EMPRESA_A, role: 'SELLER' });
    fake.sembrarDoc('uid_propio', { id: 'uid_propio', tenantId: EMPRESA_A, role: 'SELLER', status: 'ACTIVE' });

    const r = await inviteUser(EMPRESA_A, 'propio@miempresa.com', 'TENANT_MANAGER');

    expect(r).toEqual({ uid: 'uid_propio', created: false });
    expect(fake.claimsEscritos).toEqual([{ uid: 'uid_propio', claims: { tenantId: EMPRESA_A, role: 'TENANT_MANAGER' } }]);
  });

  it('cambiar el rol de alguien de MI empresa sigue funcionando', async () => {
    fake.sembrarUsuario('uid_propio', 'propio@miempresa.com', { tenantId: EMPRESA_A, role: 'SELLER' });
    fake.sembrarDoc('uid_propio', { id: 'uid_propio', tenantId: EMPRESA_A, role: 'SELLER', status: 'ACTIVE' });
    await expect(setUserRole(EMPRESA_A, 'uid_propio', 'TENANT_MANAGER')).resolves.toBeUndefined();
    expect(fake.claimsEscritos).toHaveLength(1);
  });

  it('dar de baja y de alta a alguien de MI empresa sigue funcionando', async () => {
    fake.sembrarUsuario('uid_propio', 'propio@miempresa.com', { tenantId: EMPRESA_A, role: 'SELLER' });
    fake.sembrarDoc('uid_propio', { id: 'uid_propio', tenantId: EMPRESA_A, role: 'SELLER', status: 'ACTIVE' });
    await expect(setUserActive(EMPRESA_A, 'uid_propio', false)).resolves.toBeUndefined();
    expect(fake.authUpdates).toEqual([{ uid: 'uid_propio', patch: { disabled: true } }]);
  });

  it('REACTIVAR a alguien dado de baja de MI empresa funciona (el fix no lo puede bloquear)', async () => {
    // El caso que el guard cerrado de más rompería: `setUserActive(true)` es justamente la
    // operación que revierte una baja, así que el estado DISABLED no puede impedirla.
    fake.sembrarUsuario('uid_baja', 'baja@miempresa.com', { tenantId: EMPRESA_A, role: 'SELLER' });
    fake.sembrarDoc('uid_baja', { id: 'uid_baja', tenantId: EMPRESA_A, role: 'SELLER', status: 'DISABLED' });

    await expect(setUserActive(EMPRESA_A, 'uid_baja', true)).resolves.toBeUndefined();

    expect(fake.authUpdates).toEqual([{ uid: 'uid_baja', patch: { disabled: false } }]);
    expect(fake.docs.get('users/uid_baja')).toMatchObject({ status: 'ACTIVE' });
  });

  it('pero un DESACTIVADO de OTRA empresa sigue siendo intocable', async () => {
    fake.sembrarUsuario('uid_ajeno', 'ajeno@otra.com', { tenantId: EMPRESA_B, role: 'SELLER' });
    fake.sembrarDoc('uid_ajeno', { id: 'uid_ajeno', tenantId: EMPRESA_B, role: 'SELLER', status: 'DISABLED' });
    await expect(setUserActive(EMPRESA_A, 'uid_ajeno', true)).rejects.toThrow();
    expect(fake.authUpdates).toHaveLength(0);
  });

  it('invitación a medio camino REAL (claims de mi empresa, doc faltante) se puede completar', async () => {
    // `createUser` + `setCustomUserClaims` salieron bien y sólo falló la escritura del doc:
    // reintentar tiene que terminar el trabajo, no quedar bloqueado para siempre.
    fake.sembrarUsuario('uid_a_medias', 'amedias@miempresa.com', { tenantId: EMPRESA_A, role: 'SELLER' });
    const r = await inviteUser(EMPRESA_A, 'amedias@miempresa.com', 'SELLER');
    expect(r).toEqual({ uid: 'uid_a_medias', created: false });
    expect(fake.claimsEscritos).toHaveLength(1);
    expect(fake.docs.get('users/uid_a_medias')).toMatchObject({ tenantId: EMPRESA_A });
  });

  it('un doc SIN tenantId no deja al usuario intocable: manda Auth (regresión de la review)', async () => {
    // `setUserRole`/`setUserActive` hacían merge sin `tenantId`; un doc así rechazaba a TODOS los
    // tenants, incluido el admin, para siempre. Ahora el guard cae a los claims…
    fake.sembrarUsuario('uid_parcial', 'parcial@miempresa.com', { tenantId: EMPRESA_A, role: 'SELLER' });
    fake.sembrarDoc('uid_parcial', { role: 'SELLER', updatedAt: 'ts' });
    await expect(setUserRole(EMPRESA_A, 'uid_parcial', 'TENANT_MANAGER')).resolves.toBeUndefined();
    // …y además la escritura repara el doc, para que no vuelva a pasar.
    expect(fake.docs.get('users/uid_parcial')).toMatchObject({ tenantId: EMPRESA_A, role: 'TENANT_MANAGER' });
  });

  it('el rol inválido se sigue rechazando antes de tocar nada', async () => {
    await expect(inviteUser(EMPRESA_A, 'x@y.com', 'PLATFORM_ADMIN' as never)).rejects.toThrow();
    expect(fake.claimsEscritos).toHaveLength(0);
  });
});
