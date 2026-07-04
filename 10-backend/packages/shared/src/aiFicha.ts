/**
 * aiFicha.ts — Calidad de la ficha para recomendaciones + composición determinística (CAT-1)
 * ===========================================================================================
 * Puras y compartidas: el panel muestra el nivel ("Excelente para IA") y el badge de ficha
 * incompleta, y el botón "Generar desde la ficha" arma description/aiNotes SIN IA externa —
 * solo plantillas con los datos confirmados por el vendedor (la IA nunca inventa).
 */
import type { Product, ProductAiFicha, PerfumeAttributes } from './types/product.types.js';

export type AiFichaLevel = 'incompleto' | 'basico' | 'bueno' | 'excelente';

export const AI_FICHA_LEVEL_LABEL: Record<AiFichaLevel, string> = {
  incompleto: 'Incompleto',
  basico: 'Básico',
  bueno: 'Bueno',
  excelente: 'Excelente para IA',
};

/** Lo mínimo que la calidad necesita de un producto (Product cumple esta forma). */
export interface AiFichaQualityInput {
  description?: string;
  aiNotes?: string;
  perfume?: Pick<PerfumeAttributes, 'olfactiveFamily' | 'styleTags' | 'notes' | 'sizeMl'> | null;
  aiFicha?: ProductAiFicha | null;
}

export interface AiFichaQuality {
  level: AiFichaLevel;
  /** Señales completas / totales (el total depende de si es perfume o genérico). */
  score: number;
  total: number;
  /** Etiquetas de lo que falta (para guiar al vendedor), en orden de impacto. */
  faltantes: string[];
}

const txt = (s: string | undefined | null, min = 1) => !!s && s.trim().length >= min;
const lista = (a: string[] | undefined | null, min = 1) => Array.isArray(a) && a.filter((x) => x?.trim()).length >= min;

/** Nivel de completitud de la ficha. Compatible con productos sin ficha (→ incompleto/básico). */
export function aiFichaQuality(p: AiFichaQualityInput): AiFichaQuality {
  const f = p.aiFicha ?? {};
  const esPerfume = p.perfume !== null && p.perfume !== undefined;
  const notas = p.perfume?.notes;
  const totalNotas = (notas?.top?.length ?? 0) + (notas?.heart?.length ?? 0) + (notas?.base?.length ?? 0);

  // [señal completa?, etiqueta de lo que falta]. Las señales base aplican a cualquier rubro;
  // las de perfumería (styleTags incluido: vive en PerfumeAttributes) solo si es perfume —
  // así un producto genérico puede llegar a "excelente" sin señales imposibles de cumplir.
  const señales: Array<[boolean, string]> = [
    [txt(p.description, 20), 'descripción'],
    [txt(p.aiNotes, 20), 'notas para la IA'],
    [txt(f.cuandoRecomendar, 10), 'cuándo recomendarlo'],
    [txt(f.cuandoNoRecomendar, 10), 'cuándo NO recomendarlo'],
    [txt(f.objeciones, 10), 'objeciones frecuentes'],
    [lista(f.frasesVenta), 'frases de venta'],
    [lista(f.similares), 'similares/alternativas'],
  ];
  if (esPerfume) {
    señales.push(
      [lista(p.perfume?.styleTags, 2), 'estilos (2+)'],
      [txt(p.perfume?.olfactiveFamily), 'familia olfativa'],
      [totalNotas >= 2, 'notas olfativas (2+)'],
      [(p.perfume?.sizeMl ?? 0) > 0, 'tamaño (ml)'],
      [txt(f.concentracion), 'concentración'],
      [txt(f.duracion), 'duración'],
      [txt(f.proyeccion), 'proyección'],
      [lista(f.ocasiones), 'ocasiones de uso'],
      [lista(f.clima), 'clima recomendado'],
      [txt(f.perfil), 'perfil recomendado'],
    );
  }

  const score = señales.filter(([ok]) => ok).length;
  const total = señales.length;
  const pct = score / total;
  const level: AiFichaLevel = pct < 0.25 ? 'incompleto' : pct < 0.5 ? 'basico' : pct < 0.8 ? 'bueno' : 'excelente';
  return { level, score, total, faltantes: señales.filter(([ok]) => !ok).map(([, l]) => l) };
}

const junta = (a: string[] | undefined, n = 4) => (a ?? []).filter((x) => x?.trim()).slice(0, n).join(', ');

/**
 * Notas para la IA generadas desde la ficha (SIN IA externa: plantilla con datos confirmados).
 * Compacta a ~300 chars — el tope que el sanitizador de tools le pasa al agente (aiNotes 300).
 */
export function composeAiNotesFromFicha(p: AiFichaQualityInput & Pick<Product, 'name'>): string {
  const f = p.aiFicha ?? {};
  const pf = p.perfume;
  const partes: string[] = [];

  const cab = [f.concentracion, pf?.sizeMl ? `${pf.sizeMl}ml` : '', pf?.olfactiveFamily].filter(Boolean).join(' · ');
  if (cab) partes.push(cab + '.');
  const notas = pf?.notes;
  const piramide = [
    junta(notas?.top) && `Salida: ${junta(notas?.top)}`,
    junta(notas?.heart) && `corazón: ${junta(notas?.heart)}`,
    junta(notas?.base) && `fondo: ${junta(notas?.base)}`,
  ].filter(Boolean).join('; ');
  if (piramide) partes.push(piramide + '.');
  const rendimiento = [f.duracion && `Dura ${f.duracion}`, f.proyeccion && `proyección ${f.proyeccion}`].filter(Boolean).join(', ');
  if (rendimiento) partes.push(rendimiento + '.');
  const ideal = [junta(f.ocasiones, 3), junta(f.clima, 2), f.perfil].filter(Boolean).join(' · ');
  if (ideal) partes.push(`Ideal: ${ideal}.`);
  if (txt(f.cuandoRecomendar)) partes.push(`Recomendalo si: ${f.cuandoRecomendar!.trim()}.`);
  if (txt(f.cuandoNoRecomendar)) partes.push(`Evitalo si: ${f.cuandoNoRecomendar!.trim()}.`);
  if (lista(f.similares)) partes.push(`Alternativas: ${junta(f.similares, 3)}.`);

  return compactar(partes, 300);
}

/**
 * Une partes hasta `max` chars (tope del sanitizador). Una parte que no entra se SALTEA
 * (no corta el resto: las siguientes más cortas aún pueden entrar), y si la primera ya
 * excede el tope se trunca — así una ficha válida nunca produce salida vacía en silencio.
 */
function compactar(partes: string[], max: number): string {
  let out = '';
  for (const parte of partes) {
    const cand = out ? out + ' ' + parte : parte;
    if (cand.length <= max) out = cand;
    else if (!out) out = parte.slice(0, max - 1).trimEnd() + '…';
  }
  return out;
}

/** Descripción para el CLIENTE generada desde la ficha (corta, sin datos internos). */
export function composeDescriptionFromFicha(p: AiFichaQualityInput & Pick<Product, 'name'>): string {
  const f = p.aiFicha ?? {};
  const pf = p.perfume;
  const partes: string[] = [];
  const cab = [f.concentracion, pf?.sizeMl ? `de ${pf.sizeMl}ml` : ''].filter(Boolean).join(' ');
  if (cab || pf?.olfactiveFamily) {
    partes.push([cab, pf?.olfactiveFamily ? `de la familia ${pf.olfactiveFamily.toLowerCase()}` : ''].filter(Boolean).join(' ') + '.');
  }
  const top = junta(pf?.notes?.top, 3);
  if (top) partes.push(`Abre con notas de ${top}.`);
  const rendimiento = [f.duracion && `Duración ${f.duracion}`, f.proyeccion && `proyección ${f.proyeccion}`].filter(Boolean).join(', ');
  if (rendimiento) partes.push(rendimiento + '.');
  const ideal = [junta(f.ocasiones, 2), f.perfil].filter(Boolean).join(', ');
  if (ideal) partes.push(`Ideal para ${ideal}.`);
  const out = compactar(partes, 200);
  return out ? out.charAt(0).toUpperCase() + out.slice(1) : '';
}
