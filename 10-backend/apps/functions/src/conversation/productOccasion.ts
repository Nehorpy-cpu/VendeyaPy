/**
 * conversation/productOccasion.ts — Veredicto y respuestas para "¿X sirve para Y?" (CAT-2B)
 * =========================================================================================
 * PURO (sin E/S). El bug real de prod: "El Odyssey Mega sirve para usarlo de noche?" caía al
 * listado genérico del catálogo (detectarEstilo mapea 'noche'→'intenso') y la IA — que tiene la
 * ficha y las reglas anti-complacencia — nunca corría. Estas funciones dan la respuesta HONESTA
 * desde el motor usando la ficha; el cableado (detección de producto/anáfora) vive en engine.ts.
 */
import type { Product } from '@vpw/shared';
import { fichaMencionaOcasion, type OcasionContexto } from '../catalog/fichaRank.js';

export type VeredictoOcasion = 'no_conviene' | 'conviene' | 'sin_senal';

const GS = (n: number) => `₲ ${n.toLocaleString('es-PY')}`;

/**
 * ¿La ficha dice que el producto sirve para la ocasión? El cuándo-NO del vendedor GANA sobre
 * cualquier señal positiva (es su palabra explícita). Proyección sola es señal débil de "sí"
 * (noche→fuerte, día→suave/moderada). Sin señal → el caller delega a la IA (que tiene la ficha).
 */
export function veredictoOcasion(p: Product, ocasion: OcasionContexto): VeredictoOcasion {
  const f = p.aiFicha ?? {};
  if (fichaMencionaOcasion([f.cuandoNoRecomendar], ocasion)) return 'no_conviene';
  if (fichaMencionaOcasion([f.ocasiones, f.clima, f.cuandoRecomendar], ocasion)) return 'conviene';
  const proy = (f.proyeccion ?? '').trim().toLowerCase();
  if (ocasion === 'noche' && proy === 'fuerte') return 'conviene';
  if (ocasion === 'dia' && (proy === 'suave' || proy === 'moderada')) return 'conviene';
  return 'sin_senal';
}

const OCASION_LABEL: Record<OcasionContexto, string> = { noche: 'salir de noche', dia: 'el día u oficina' };

/** La ficha admite hasta 500 chars por campo; en una burbuja de chat se capa (review CAT-2B). */
const cap = (s: string, max = 120): string => {
  const limpio = s.trim().replace(/\s+/g, ' ');
  return Array.from(limpio).length > max ? Array.from(limpio).slice(0, max).join('').trimEnd() + '…' : limpio;
};

/** "es más fresco y diario" — descripción corta del producto desde SU ficha (sin inventar). */
function perfilDesdeFicha(p: Product): string {
  const f = p.aiFicha ?? {};
  const rasgos = [...(f.ocasiones ?? []), ...(f.perfil ? [f.perfil.split(',')[0]!.trim()] : [])]
    .map((x) => cap(x.trim(), 40)).filter(Boolean).slice(0, 2);
  return rasgos.length ? `es más ${rasgos.join(' y ')}` : 'no es el que solemos recomendar para esa ocasión';
}

/** " — proyecta fuerte y dura 8-10" — motivo de la alternativa desde SU ficha (vacío si no hay datos). */
function motivoDesdeFicha(p: Product): string {
  const f = p.aiFicha ?? {};
  const partes = [
    f.proyeccion ? `proyecta ${f.proyeccion}` : '',
    f.duracion ? `dura ${f.duracion}` : '',
  ].filter(Boolean);
  return partes.length ? ` — ${partes.join(' y ')}` : '';
}

/** El cuándo-NO del vendedor dice que no: corrección honesta + alternativa del ranking (si hay). */
export function respuestaOcasionNoConviene(p: Product, ocasion: OcasionContexto, alternativa: Product | null): string {
  const base = `Te soy honesta: el *${p.name}* ${perfilDesdeFicha(p)} — no es mi primera recomendación para ${OCASION_LABEL[ocasion]}.`;
  if (!alternativa) return `${base} ¿Querés que te muestre opciones que sí vayan bien para eso?`;
  return (
    `${base}\n\nPara ${OCASION_LABEL[ocasion]} te conviene más el *${alternativa.name}* (${GS(alternativa.price)})` +
    `${motivoDesdeFicha(alternativa)}. ¿Querés que te lo agregue?`
  );
}

/** La ficha dice que sí: confirmación honesta con el porqué + oferta del consultado. */
export function respuestaOcasionConviene(p: Product, ocasion: OcasionContexto): string {
  const f = p.aiFicha ?? {};
  const motivo = f.cuandoRecomendar?.trim()
    ? `: ideal si ${cap(f.cuandoRecomendar)}`
    : motivoDesdeFicha(p).replace(' — ', ': ');
  return `¡Sí! El *${p.name}* va muy bien para ${OCASION_LABEL[ocasion]}${motivo}. ¿Te lo agrego?`;
}
