import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { META_SYNC_STATE } from '@vpw/shared';
import { CAMPOS_CRITICOS, DRIFT_STATES, ESTADOS_BLOQUEANTES } from './driftGuard.js';
import { WRITABLE_FIELDS } from '../meta/catalogOwnership.js';

/**
 * CONSISTENCIA DE CONTRATOS (ADR-0015).
 *
 * El mismo concepto está declarado en tres lugares a propósito, y el desacople es DELIBERADO:
 *  · el guard del bot (`catalog/driftGuard.ts`) no puede importar la reconciliación ni el
 *    cliente del catálogo — se carga en el arranque de todas las funciones;
 *  · el panel (`apps/web`) no comparte runtime con las Cloud Functions;
 *  · `packages/shared` define el estado que se PERSISTE, que no es lo mismo que el derivado.
 *
 * Lo que faltaba era algo que ATE las tres copias. Hoy coinciden por disciplina: agregar un campo
 * crítico (p.ej. `sale_price` para promociones) en un solo lado dejaba a los otros dos
 * desactualizados EN SILENCIO — el bot cortando una venta que el panel muestra en verde, o al
 * revés. Este test no unifica los módulos: los ata.
 *
 * SI ESTE TEST FALLA: no relajes la aserción. Actualizá las TRES copias (backend guard,
 * verificación y panel) y recién ahí ajustá la lista de acá. Si de verdad tienen que divergir,
 * documentá el porqué en el ADR primero.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERIFICACION = resolve(SRC, 'meta/catalogVerification.ts');
const PANEL = resolve(SRC, '../../web/src/lib/catalogOwnership.ts');

/**
 * Lee una lista de literales de un archivo que este paquete NO puede importar: el panel es otro
 * runtime, y `catalogVerification.ts` arrastra axios + la reconciliación entera (importarlo acá
 * solo para leer cuatro constantes contradiría el límite de arranque que custodia el otro test).
 */
function listaDeclarada(archivo: string, nombre: string): string[] {
  const src = readFileSync(archivo, 'utf8');
  const m = new RegExp(`(?:export\\s+)?const\\s+${nombre}\\s*(?::[^=]+)?=\\s*\\[([^\\]]*)\\]`).exec(src);
  if (!m) throw new Error(`No se pudo leer \`${nombre}\` en ${archivo}. Si lo renombraste, actualizá este test: ata contratos que no comparten runtime.`);
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

const ordenado = (xs: readonly string[]): string[] => [...xs].sort();

describe('contratos compartidos de deriva del catálogo', () => {
  it('ESTADOS: el eje derivado del guard es el persistido + `stale` (que jamás se persiste)', () => {
    // `stale` se DERIVA en lectura (ADR-0015 §5): por eso está en el guard y no en el enum que
    // describe lo que se guarda en Firestore.
    expect(ordenado(DRIFT_STATES)).toEqual(ordenado([...META_SYNC_STATE, 'stale']));
    expect(ESTADOS_BLOQUEANTES.every((e) => (DRIFT_STATES as readonly string[]).includes(e))).toBe(true);
  });

  it('ESTADOS: el panel muestra los mismos, más `desconocido` (nunca se verificó)', () => {
    // El panel distingue "vencida" (existió y caducó) de "sin verificar" (nunca ocurrió). Esa
    // séptima etiqueta es SOLO de presentación: no es un estado que el backend produzca.
    expect(ordenado(listaDeclarada(PANEL, 'ESTADOS_META'))).toEqual(ordenado([...DRIFT_STATES, 'desconocido']));
  });

  it('CAMPOS CRÍTICOS: guard, verificación y panel declaran exactamente los mismos', () => {
    // Divergir acá significa que el bot corta una venta que el panel pinta como cosmética (o
    // peor: que la verificación la marca cosmética y el bot cotiza un precio que no verificó).
    const enVerificacion = listaDeclarada(VERIFICACION, 'COMMERCIAL_FIELDS');
    const enPanel = listaDeclarada(PANEL, 'CAMPOS_CRITICOS');
    expect(ordenado(enVerificacion)).toEqual(ordenado(CAMPOS_CRITICOS));
    expect(ordenado(enPanel)).toEqual(ordenado(CAMPOS_CRITICOS));
  });

  it('CAMPOS PÚBLICOS: el contrato de escritura y el del panel son el mismo', () => {
    expect(ordenado(listaDeclarada(PANEL, 'CAMPOS_PUBLICOS'))).toEqual(ordenado(WRITABLE_FIELDS));
  });

  it('todo campo crítico es un campo público con dueño declarable', () => {
    // Un campo crítico que no fuera `WritableField` no podría tener dueño, y el guard bloquearía
    // por algo que nadie puede reclamar ni corregir en el origen.
    expect(CAMPOS_CRITICOS.every((c) => (WRITABLE_FIELDS as readonly string[]).includes(c))).toBe(true);
  });
});
