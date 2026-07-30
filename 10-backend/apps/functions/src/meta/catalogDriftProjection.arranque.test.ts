import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { metaDriftProjection } from './catalogDriftProjection.js';
import { driftGuardCableado, setDriftProjection } from '../catalog/driftGuard.js';

/**
 * COSTO DE ARRANQUE. `index.ts` cablea la proyección de deriva en el módulo raíz, así que TODO
 * lo que esa proyección alcance se carga en el cold start de CADA Cloud Function del proyecto —
 * incluidas las que no tienen nada que ver con el catálogo (pagos, webhooks, onboarding).
 * Importando la verificación entera se arrastraban ~106 KB de módulos y el cliente HTTP del
 * catálogo (axios) a todas.
 *
 * Este test es un límite de arquitectura, no un detalle de implementación: la lista de abajo es
 * un permiso explícito. Si aparece un módulo nuevo, la pregunta no es "¿lo agrego a la lista?"
 * sino "¿esto tiene que cargarse en el arranque de una función de pagos?".
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Imports RELATIVOS de un archivo, salteando los `import type` / `export type` (se borran al
 * compilar: no cuestan nada en el arranque). No sigue `await import()` dinámicos a propósito:
 * justamente lo que se quiere medir es el grafo ESTÁTICO.
 */
const RE_IMPORT = /(?:^|\n)\s*((?:import|export)\s[^;]*?from\s*['"](\.[^'"]+)['"])/g;

function grafoEstatico(entrada: string): string[] {
  const vistos = new Set<string>();
  const pendientes = [entrada];
  while (pendientes.length) {
    const archivo = pendientes.pop()!;
    if (vistos.has(archivo)) continue;
    vistos.add(archivo);
    for (const m of readFileSync(archivo, 'utf8').matchAll(RE_IMPORT)) {
      if (/^(?:import|export)\s+type\s/.test(m[1]!)) continue;
      pendientes.push(resolve(dirname(archivo), m[2]!.replace(/\.js$/, '.ts')));
    }
  }
  return [...vistos].map((f) => relative(SRC, f).split(sep).join('/')).sort();
}

afterEach(() => setDriftProjection(null));

describe('meta/catalogDriftProjection — peso del arranque global', () => {
  it('la proyección solo alcanza módulos LIVIANOS (nada de cliente del catálogo ni reconciliación)', () => {
    expect(grafoEstatico(resolve(SRC, 'meta/catalogDriftProjection.ts'))).toEqual([
      'catalog/driftGuard.ts',
      'lib/firebase.ts',
      'lib/logger.ts',
      'meta/catalogDriftProjection.ts',
      'meta/catalogOwnership.ts',
      'meta/catalogSyncConfig.ts',
      'meta/catalogVerificationState.ts',
    ]);
  });

  it('en particular NO arrastra `catalogClient` (axios) ni `catalogVerification`', () => {
    const alcanzado = grafoEstatico(resolve(SRC, 'meta/catalogDriftProjection.ts'));
    expect(alcanzado).not.toContain('meta/catalogClient.ts');
    expect(alcanzado).not.toContain('meta/catalogVerification.ts');
  });

  it('el cableado ocurre EXACTAMENTE una vez y con import estático (nunca diferido)', () => {
    const index = readFileSync(resolve(SRC, 'index.ts'), 'utf8');
    // Una sola llamada: dos cableados serían dos proyecciones y la última ganaría en silencio.
    expect(index.match(/setDriftProjection\(/g) ?? []).toHaveLength(1);
    expect(index).toMatch(/setDriftProjection\(metaDriftProjection\)/);
    // Estático: un import diferido acá dejaría el guard INERTE hasta la primera carga, que es
    // peor que el costo que ahorra (el bot afirmando precios que nadie verificó).
    expect(index).toMatch(/^import \{ metaDriftProjection \} from '\.\/meta\/catalogDriftProjection\.js';$/m);
  });

  it('adelgazar el grafo no dejó el guard inerte: cablearla lo enciende', () => {
    expect(driftGuardCableado()).toBe(false);
    setDriftProjection(metaDriftProjection);
    expect(driftGuardCableado()).toBe(true);
  });
});
