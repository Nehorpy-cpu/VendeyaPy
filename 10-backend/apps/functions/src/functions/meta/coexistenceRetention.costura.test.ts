/**
 * coexistenceRetention.costura.test.ts — la COSTURA entre quien crea una colección con `expiresAt`
 * y quien la purga (ADR-0017 §4)
 * =================================================================================================
 * POR QUÉ EXISTE ESTE TEST, y no otro más de comportamiento: la lista de colecciones del barrido
 * está escrita A MANO. Ya se abrió una vez — una superficie nueva (`metaWebhookShadow`, con el
 * teléfono del cliente y el texto íntegro de los mensajes) nació con `expiresAt`, y la lista del
 * barrido seguía diciendo «las dos colecciones del archivo, ninguna otra». El `expiresAt` quedó
 * DECORATIVO: sin política TTL declarada y sin barrido, esos documentos se guardaban para siempre.
 *
 * Nadie se olvidó de nada por descuido: son dos archivos distintos, tocados en momentos distintos.
 * Por eso la garantía no puede ser «acordarse», tiene que ser mecánica. Las tres declaraciones que
 * hacen real una retención se verifican entre sí:
 *
 *   1. el BARRIDO del repo      (`COEXISTENCE_RETENTION_COLLECTIONS`)
 *   2. la POLÍTICA TTL          (`firestore.indexes.json` → fieldOverrides con `ttl: true`)
 *   3. la REGLA DE ACCESO       (`firestore.rules` → match explícito `read, write: if false`)
 *
 * Y además se mira el código: toda constante de colección RAÍZ declarada en un módulo que escribe
 * `expiresAt` tiene que estar en el barrido. Una colección nueva con TTL rompe este test el día
 * que se escribe, no el día que alguien audita retención.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { COEXISTENCE_RETENTION_COLLECTIONS } from './coexistenceRetention.js';

/** `apps/functions/src/functions/meta` → raíz del backend (5 niveles arriba). */
const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const SRC = join(RAIZ, 'apps', 'functions', 'src');

/**
 * Colecciones con `expiresAt` que NO barre este job, con su motivo. Vacía a propósito: agregar una
 * entrada acá es una decisión explícita y revisable, no un olvido silencioso.
 */
const FUERA_DEL_BARRIDO: Readonly<Record<string, string>> = Object.freeze({});

function archivosTs(dir: string, acc: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    const p = join(dir, entrada);
    if (statSync(p).isDirectory()) {
      if (entrada !== 'node_modules' && entrada !== 'lib') archivosTs(p, acc);
    } else if (entrada.endsWith('.ts') && !entrada.endsWith('.test.ts')) {
      acc.push(p);
    }
  }
  return acc;
}

/** Constantes de colección RAÍZ declaradas en módulos que además escriben `expiresAt`. */
function coleccionesConTtlEnElCodigo(): Array<{ nombre: string; archivo: string }> {
  const encontradas: Array<{ nombre: string; archivo: string }> = [];
  for (const archivo of archivosTs(SRC)) {
    const src = readFileSync(archivo, 'utf8');
    if (!src.includes('expiresAt')) continue;
    for (const m of src.matchAll(/export const ([A-Z0-9_]+_COLLECTION)\s*=\s*'([^']+)'/g)) {
      encontradas.push({ nombre: m[2]!, archivo });
    }
  }
  return encontradas;
}

const indexes = JSON.parse(readFileSync(join(RAIZ, 'firestore.indexes.json'), 'utf8')) as {
  fieldOverrides?: Array<{ collectionGroup: string; fieldPath: string; ttl?: boolean }>;
};
const rules = readFileSync(join(RAIZ, 'firestore.rules'), 'utf8');

const conPoliticaTtl = (indexes.fieldOverrides ?? [])
  .filter((f) => f.ttl === true && f.fieldPath === 'expiresAt')
  .map((f) => f.collectionGroup);

describe('costura de retención: nadie declara una colección con TTL fuera del barrido', () => {
  it('toda colección raíz declarada en el código con `expiresAt` está en el barrido', () => {
    const barrido = new Set(COEXISTENCE_RETENTION_COLLECTIONS);
    const huerfanas = coleccionesConTtlEnElCodigo()
      .filter((c) => !barrido.has(c.nombre) && !(c.nombre in FUERA_DEL_BARRIDO))
      .map((c) => c.nombre);
    expect(huerfanas).toEqual([]);
  });

  it('el barrido y la política TTL declaran EXACTAMENTE el mismo conjunto', () => {
    // Las dos direcciones importan: una colección barrida sin `ttl:true` depende de que el job
    // corra siempre; una con `ttl:true` fuera del barrido depende de que alguien haya desplegado
    // los índices — y el borrado por TTL de Firestore ni siquiera es inmediato.
    expect([...conPoliticaTtl].sort()).toEqual([...COEXISTENCE_RETENTION_COLLECTIONS].sort());
  });

  it('cada colección barrida tiene su regla EXPLÍCITA cerrada en firestore.rules', () => {
    // El default-deny ya las cubre; el ADR pide declararlas igual, para que el cierre se lea en el
    // archivo y no dependa de recordar que existe un default.
    for (const coleccion of COEXISTENCE_RETENTION_COLLECTIONS) {
      const bloque = new RegExp(`match /${coleccion}/\\{[^}]+\\}\\s*\\{\\s*allow read, write: if false;`);
      expect(bloque.test(rules), `falta la regla explícita de ${coleccion}`).toBe(true);
    }
  });
});
