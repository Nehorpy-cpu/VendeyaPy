/**
 * backupInfra.test.ts — El manifiesto de infraestructura tiene que describir ESTE repo.
 * =====================================================================================
 * Un manifiesto de infraestructura que se genera sin fallar pero no encuentra nada es exactamente
 * el tipo de artefacto que engaña: se archiva, nadie lo lee hasta el incidente y ese día resulta que
 * estaba vacío. Así que estos tests no verifican "que la función corra": verifican que, corrida
 * sobre el repo real, **encuentre los hechos que sabemos que existen**.
 *
 * El más importante es el de las políticas TTL. **Un restore NO las repone** — son configuración de
 * la base, no datos —, y las tres que hay protegen las colecciones más sensibles del sistema: el
 * historial importado (hasta 180 días de conversaciones privadas) y la superficie de observación de
 * `shadow` (teléfono y texto de mensajes). Si el manifiesto no las enumera, nadie las va a recrear.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ttlDeclaradas, functionsExportadas, schedulersDeclarados, secretosDeclarados, nombresDeEnv, PENDIENTES_FUERA_DE_ALCANCE } from '../../scripts/backup-infra.mjs';
import { RAIZ_BACKEND } from '../../scripts/backup-lib.mjs';

const indexes = JSON.parse(readFileSync(join(RAIZ_BACKEND, 'firestore.indexes.json'), 'utf8'));

describe('políticas TTL — lo que un restore NO repone', () => {
  const declaradas = ttlDeclaradas(indexes);

  it('encuentra las CUATRO políticas TTL reales del repo (si esto da 0, el manifiesto miente)', () => {
    // ADR-0020 (G9) sumó la limpieza pasiva de los nonces de conexión (`metaOAuthStates.expiresAt`,
    // sin PII) a las tres de Coexistence. Un restore tampoco repone esta: el manifiesto la enumera.
    expect(declaradas.length).toBe(4);
    expect(declaradas.map((t: { coleccion: string }) => t.coleccion).sort()).toEqual([
      'metaOAuthStates', 'metaWebhookAppState', 'metaWebhookHistory', 'metaWebhookShadow',
    ]);
  });

  it('cada una nombra el campo sobre el que se aplica', () => {
    for (const t of declaradas) expect(t.campo).toBe('expiresAt');
  });

  it('NO cuenta como TTL un fieldOverride que no lo es', () => {
    expect(ttlDeclaradas({ fieldOverrides: [{ collectionGroup: 'x', fieldPath: 'y', ttl: false }] })).toEqual([]);
    expect(ttlDeclaradas({ fieldOverrides: [{ collectionGroup: 'x', fieldPath: 'y' }] })).toEqual([]);
  });

  it('el manifiesto declara que esta lista es INCOMPLETA (el TTL de metaWebhookInbox es de consola)', () => {
    const pendiente = PENDIENTES_FUERA_DE_ALCANCE.find((p: { que: string }) => /TTL/.test(p.que));
    expect(pendiente).toBeDefined();
    expect(pendiente!.comando).toMatch(/ttls list/);
    expect(pendiente!.porque).toMatch(/metaWebhookInbox/);
  });
});

describe('functions y schedulers — lo que hay que volver a desplegar', () => {
  const fuenteIndex = readFileSync(join(RAIZ_BACKEND, 'apps', 'functions', 'src', 'index.ts'), 'utf8');

  it('enumera funciones reales del repo', () => {
    const nombres = functionsExportadas(fuenteIndex);
    expect(nombres.length).toBeGreaterThan(20);
    expect(nombres).toContain('onWebhookInbox');
  });

  it('NO cuenta las funciones COMENTADAS (existen decenas en index.ts y no están desplegadas)', () => {
    const nombres = functionsExportadas(fuenteIndex);
    // `whatsappWebhook` está comentado en index.ts desde el paso a Cloud API.
    expect(nombres).not.toContain('whatsappWebhook');
    expect(functionsExportadas("// export { fantasma } from './x.js';")).toEqual([]);
  });

  it('encuentra los schedulers con su cron y su zona horaria', () => {
    const declarados = schedulersDeclarados([
      { archivo: 'x.ts', texto: "export const jobDiario = onSchedule({ schedule: '30 3 * * *', timeZone: 'America/Asuncion' }, async () => {});" },
    ]);
    expect(declarados).toEqual([{ nombre: 'jobDiario', archivo: 'x.ts', cron: '30 3 * * *', zonaHoraria: 'America/Asuncion' }]);
  });

  it('el manifiesto avisa que un rollback de código NO frena un scheduler desplegado', () => {
    const pendiente = PENDIENTES_FUERA_DE_ALCANCE.find((p: { que: string }) => /Scheduler/i.test(p.que));
    expect(pendiente).toBeDefined();
    expect(pendiente!.porque).toMatch(/rollback de código no frena|no frena/i);
  });
});

describe('secretos y configuración — NOMBRES, jamás valores', () => {
  it('encuentra los secretos declarados con defineSecret', () => {
    const nombres = secretosDeclarados([
      { archivo: 'a.ts', texto: "export const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');" },
      { archivo: 'b.ts', texto: "export const META_APP_SECRET = defineSecret('META_APP_SECRET');" },
    ]);
    expect(nombres).toEqual(['ANTHROPIC_API_KEY', 'META_APP_SECRET']);
  });

  it('de un `.env` toma los NOMBRES y descarta los valores', () => {
    const nombres = nombresDeEnv('API_KEY=valor-supersecreto\n# comentario\nOTRA_VAR=x\n');
    expect(nombres).toEqual(['API_KEY', 'OTRA_VAR']);
    expect(JSON.stringify(nombres)).not.toContain('supersecreto');
  });

  it('el manifiesto advierte que NO hay que ejecutar el comando que imprime valores de secretos', () => {
    const pendiente = PENDIENTES_FUERA_DE_ALCANCE.find((p: { que: string }) => /secretos/i.test(p.que));
    expect(pendiente!.comando).toMatch(/NO ejecutar/);
  });
});

describe('IAM — el grant invisible que rompe el visor de comprobantes', () => {
  it('queda registrado como pendiente, con su comando y su razón', () => {
    const pendiente = PENDIENTES_FUERA_DE_ALCANCE.find((p: { que: string }) => /IAM/.test(p.que));
    expect(pendiente).toBeDefined();
    expect(pendiente!.porque).toMatch(/serviceAccountTokenCreator/);
  });
});
