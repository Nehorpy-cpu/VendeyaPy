/**
 * catalog/fichaRank.ts — Ranking determinístico por FICHA (CAT-2)
 * ===============================================================
 * PURO (sin E/S). Puntúa un producto contra el texto libre del cliente usando la ficha de
 * recomendaciones (ocasiones/clima/proyección/cuándo-NO) y la pirámide olfativa (notas).
 * Lo consume searchCatalog vía `filters.texto`: suma al score de relevancia SIN saltear los
 * filtros explícitos (género/precio) ni el pinning por nombre (F1B), que siguen mandando.
 *
 * Diseño de pesos (ver fichaRank.test.ts con los productos reales de la perfumería):
 *   ocasión de la ficha coincide     +6   (señal directa del vendedor)
 *   cuándo-NO coincide con lo pedido −6   (el vendedor dijo explícitamente que NO)
 *   cuándo-SÍ coincide               +4
 *   nota de la pirámide nombrada     +4   ("piña" → corazón con piña)
 *   clima coincide                   +2
 *   proyección encaja con la ocasión +2   (noche→fuerte, día→suave/moderada)
 * Quedan por debajo del pinning por nombre y por encima de featured/isNew (+1/+0.5).
 */
import type { Product } from '@vpw/shared';
import { normalizeText } from './match.js';

/** Contexto de ocasión detectado en el texto del cliente. */
export type OcasionContexto = 'noche' | 'dia';

/**
 * Keywords del LADO CONSULTA (lo que pide el cliente). Curadas por el review adversarial:
 * - sin 'elegante'/'formal' (adjetivos de estilo: "algo elegante para la oficina" NO es noche);
 * - sin 'salida'/'salidas' ("notas de salida" es jerga de pirámide olfativa — queda 'salir');
 * - sin 'manana' ("mañana paso a retirar" = tomorrow, no morning).
 */
const KW_NOCHE = ['noche', 'nocturna', 'nocturno', 'salir', 'fiesta', 'fiestas', 'evento', 'eventos', 'boliche', 'cita', 'citas'];
const KW_DIA = ['dia', 'diario', 'oficina', 'trabajo', 'laburo', 'clase', 'clases', 'facultad', 'cotidiano'];

/**
 * Frases que NO son un pedido de ocasión y se quitan ANTES de detectar: saludos ("buen día",
 * "buenas noches"), narrativa temporal ("ayer a la noche vi el anuncio", "el otro día") y
 * duración coloquial ("me dura todo el día"). Sobre texto ya normalizado (sin acentos).
 */
const FRASES_NO_OCASION = /\b(buen dia|buenos dias|buenas tardes|buenas noches|ayer a la noche|ayer de noche|anoche|el otro dia|todo el dia)\b/g;

/** Sinónimos que buscamos DENTRO de la ficha (ocasiones/clima/cuándo) para cada contexto.
 * Acá SÍ vale el vocabulario amplio: es lo que escribió el VENDEDOR ("salidas nocturnas",
 * "eventos formales", "elegante"), no lo que dijo el cliente. */
const FICHA_NOCHE = new Set([...KW_NOCHE, 'salida', 'salidas', 'elegante', 'formal', 'formales', 'especial', 'especiales', 'intenso', 'intensa']);
const FICHA_DIA = new Set([...KW_DIA, 'manana', 'fresco', 'fresca', 'suave', 'casual']);

const tokens = (s: string | undefined | null): string[] => normalizeText(s ?? '').split(' ').filter((t) => t.length >= 3);

/**
 * Ocasión pedida por el cliente, si el texto la menciona ('noche' | 'dia' | undefined).
 * Con señales de AMBAS ocasiones ("elegante..." no cuenta; "para el día y la noche" sí) el
 * resultado es undefined: ante la ambigüedad no se sesga el ranking (review CAT-2).
 */
export function detectarOcasionContexto(texto: string): OcasionContexto | undefined {
  const limpio = normalizeText(texto).replace(FRASES_NO_OCASION, ' ');
  const ts = new Set(limpio.split(' ').filter((t) => t.length >= 3));
  const noche = KW_NOCHE.some((k) => ts.has(k));
  const dia = KW_DIA.some((k) => ts.has(k));
  if (noche && dia) return undefined;
  if (noche) return 'noche';
  if (dia) return 'dia';
  return undefined;
}

const intersecta = (fichaCampos: Array<string | string[] | undefined | null>, set: Set<string>): boolean =>
  fichaCampos.some((campo) => {
    const list = Array.isArray(campo) ? campo : [campo];
    return list.some((x) => tokens(typeof x === 'string' ? x : '').some((t) => set.has(t)));
  });

/**
 * Score de la ficha contra el texto del cliente. 0 si no hay ficha o el texto no da señales.
 * Nunca lee datos privados (la ficha es guía de venta; costo/margen viven en financials).
 */
export function fichaScore(p: Product, texto: string): number {
  const f = p.aiFicha ?? {};
  const ocasion = detectarOcasionContexto(texto);
  let score = 0;

  if (ocasion) {
    const set = ocasion === 'noche' ? FICHA_NOCHE : FICHA_DIA;
    if (intersecta([f.ocasiones], set)) score += 6;
    if (intersecta([f.clima], set)) score += 2;
    if (intersecta([f.cuandoRecomendar], set)) score += 4;
    // El vendedor dijo explícitamente cuándo NO: pesa en contra aunque otra señal sume.
    if (intersecta([f.cuandoNoRecomendar], set)) score -= 6;
    const proy = normalizeText(f.proyeccion ?? '');
    if (ocasion === 'noche' && proy === 'fuerte') score += 2;
    if (ocasion === 'dia' && (proy === 'suave' || proy === 'moderada')) score += 2;
  }

  // Notas de la pirámide nombradas por el cliente ("olor a piña" → corazón con piña).
  const notas = p.perfume?.notes;
  const notaTokens = new Set(
    [...(notas?.top ?? []), ...(notas?.heart ?? []), ...(notas?.base ?? [])].flatMap((n) => tokens(n)),
  );
  // Solo tokens con poder de nota (≥4 chars) para no matchear palabras cortas genéricas.
  if (tokens(texto).some((t) => t.length >= 4 && notaTokens.has(t))) score += 4;

  return score;
}
