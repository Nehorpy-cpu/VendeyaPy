/**
 * catalog/matchIdentificacion.ts — Identificación fail-closed de UN producto (ADR-0019, hito B+C)
 * ===============================================================================================
 * PURA (sin E/S, sin red, sin DB): decide si la consulta extraída de una imagen IDENTIFICA a un
 * candidato del catálogo. Reusa el score tokenizado de match.ts (normalización de acentos/signos
 * y stoplist de compra incluidas) con la MISMA vara para cualquier vertical — perfumería, jardín,
 * electrónica... — sin léxicos ni umbrales por rubro.
 *
 * Principio: la identidad se gana con EVIDENCIA DE NOMBRE, nunca con la forma de la lista.
 * - El CONTEO y la POSICIÓN jamás identifican: que searchCatalog devuelva un solo candidato no
 *   dice nada sobre ese candidato — "identificar" al único por estar solo era el defecto que este
 *   módulo corrige. Un empate se ordena determinísticamente (nombre/id) solo para PRESENTAR: el
 *   desempate nunca elige un ganador.
 * - El PRECIO jamás desempata: dos nombres igual de cercanos con precios distintos son AMBIGUOS.
 *   El precio es un dato del servidor para mostrar, no una señal de identidad de la foto.
 * - El MARGEN exige que el 1º supere al 2º por al menos un token exacto (MARGEN_INEQUIVOCO):
 *   entre variantes cercanas ("... Clásica" vs "... Moderna") elegir al de score apenas mayor
 *   sería una selección arbitraria disfrazada — se prefiere repreguntar (ambiguous).
 * Cualquier duda ⇒ ambiguous o no_match (fail-closed): repreguntar es barato; afirmar mal, no.
 */
import { normalizeText, productMatchScore, queryTokens } from './match.js';

/** Lo mínimo que la identificación necesita de un candidato (ProductoOfrecible cumple esta forma). */
export interface CandidatoIdentificable { id: string; name: string; price: number }

export type Identificacion =
  | { tipo: 'matched'; producto: CandidatoIdentificable; evidencia: { score: number; margen: number } }
  | { tipo: 'ambiguous'; productos: CandidatoIdentificable[] } // 2..3, orden por score desc
  | { tipo: 'no_match' };

/** Piso de evidencia: ≥2 tokens exactos (2+2) o token exacto + frase íntegra en el nombre (2+3).
 *  Un token suelto entre ruido (2 + cobertura parcial < 4) jamás identifica. */
export const UMBRAL_IDENTIFICACION = 4;
/** El 1º debe superar al 2º por al menos un token exacto (2): menos que eso es empate práctico. */
export const MARGEN_INEQUIVOCO = 2;
/** Tope de opciones a repreguntar (espeja el máximo de la respuesta de visión). */
const MAX_AMBIGUOS = 3;

/**
 * Evidencia ESTRUCTURAL, además del umbral numérico (review adversarial, MEDIO 1): el score solo
 * no alcanza — `productMatchScore` llega a 4 con prefijo(1)+frase(3) sin UN SOLO token exacto
 * ('odys' contra "ARMAF ODYSSEY…"), y una consulta de UNA palabra se auto-cuenta como frase
 * (la marca sola: 'lattafa' ⇒ 2+3). La identidad exige lo que el contrato documenta:
 * ≥2 tokens exactos del nombre, o 1 exacto + la consulta ÍNTEGRA (≥2 tokens con peso) contenida
 * en el nombre. Un fragmento truncado o la marca a secas ⇒ modelo insuficiente ⇒ jamás matched.
 */
function evidenciaEstructural(consulta: string, nombre: string): boolean {
  const qt = queryTokens(consulta);
  const enNombre = new Set(queryTokens(nombre));
  const exactos = qt.filter((t) => enNombre.has(t)).length;
  if (exactos >= 2) return true;
  const frase = normalizeText(consulta);
  return exactos >= 1 && qt.length >= 2 && frase.length > 0 && normalizeText(nombre).includes(frase);
}

/**
 * Identifica a lo sumo UN producto para la consulta, o degrada con honestidad:
 * 0 elegibles ⇒ no_match · 1 elegible ⇒ matched · 2+ elegibles ⇒ matched solo con margen
 * inequívoco, si no ambiguous. Elegible = umbral numérico Y evidencia estructural. La evidencia
 * expuesta son SOLO números (score y margen contra el mejor rival) — jamás texto crudo de la
 * imagen ni del catálogo.
 */
export function identificarProducto(consulta: string, candidatos: CandidatoIdentificable[]): Identificacion {
  // Copia ordenada: score desc; empate → nombre normalizado y luego id (DETERMINÍSTICO: el
  // resultado no puede depender del orden en que llegó la lista — sería posición identificando).
  const puntuados = candidatos
    .map((c) => ({ c, score: productMatchScore(consulta, { name: c.name }), nombre: normalizeText(c.name) }))
    .sort((a, b) => b.score - a.score || a.nombre.localeCompare(b.nombre) || a.c.id.localeCompare(b.c.id));
  const elegibles = puntuados.filter((x) => x.score >= UMBRAL_IDENTIFICACION && evidenciaEstructural(consulta, x.c.name));
  const mejor = elegibles[0];
  if (!mejor) return { tipo: 'no_match' };
  // Margen contra el mejor RIVAL global (elegible o no; sin rival = todo el score a favor).
  const margen = mejor.score - (puntuados[1]?.score ?? 0);
  if (elegibles.length === 1 || margen >= MARGEN_INEQUIVOCO) {
    return { tipo: 'matched', producto: mejor.c, evidencia: { score: mejor.score, margen } };
  }
  return { tipo: 'ambiguous', productos: elegibles.slice(0, MAX_AMBIGUOS).map((x) => x.c) };
}
