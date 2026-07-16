/**
 * COVERAGE-GUARD-1 — guard determinístico de afirmaciones logísticas.
 * =====================================================================
 * Hallazgo real (smoke AI-FALLBACK, 2026-07-16): ante "¿hacen envíos al interior?" la IA extrapoló
 * la FAQ genérica de envíos ("hacemos envíos") a cobertura geográfica concreta ("sí, al interior
 * del país") sin ningún dato estructurado de zonas. Mientras COVERAGE-1 (ubicación + aprobación
 * manual) no esté construido, las consultas de cobertura/costo/plazo de envío se responden acá,
 * de forma segura y honesta, SIN llamar a la IA. El detector cubre las formulaciones frecuentes
 * (es imposible enumerar todas): lo que escape cae a la IA, donde la regla "ENVÍOS Y COBERTURA"
 * del prompt es la segunda línea de defensa.
 *
 * Garantías:
 *  - Determinístico y PURO (solo texto → boolean); nada de tenant/país/ciudades hardcodeadas.
 *  - No deriva solo: si el cliente quiere confirmar, pide un vendedor y HANDOFF-2 hace el pase real.
 *  - No toca carrito, pedidos, pagos, stock ni estado de sesión.
 */

/** Respuesta segura: no afirma cobertura, costo ni plazo; invita al pase humano vía HANDOFF-2. */
export const RESPUESTA_COBERTURA_SEGURA =
  'La cobertura, el costo y el tiempo de envío dependen de la ubicación y deben ser confirmados ' +
  'por el equipo. Si querés confirmarlo ahora, decime que querés hablar con un vendedor.';

const normalizar = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

/**
 * ¿El mensaje pregunta por cobertura, costo o plazo logístico?
 * Exclusiones primero (falsos positivos conocidos), después los patrones de intención logística.
 */
export function esConsultaCobertura(text: string): boolean {
  const n = normalizar(text);

  // ---- Exclusiones: turnos que NO son consulta de cobertura ----
  // Comprobantes / pagos que el cliente "envía" al negocio.
  if (/\b(comprobante|captura|recibo|boleta|factura|transferencia|deposito)\b/.test(n)) return false;
  // Pedido de material/datos al bot: "enviame/mandame fotos, el QR, la dirección para retirar…".
  if (/\b(envia|manda|pasa)(me|nos)\b/.test(n)) return false;
  if (/\b(enviar|mandar|pasar)(me|nos)?\s+(el\s+|la\s+|los\s+|las\s+|unas?\s+|unos\s+)?(foto|imagen|video|catalogo|lista|info|informacion|precio|dato|link|qr|direccion|ubicacion)/.test(n)) return false;
  // Retiro en persona: pide la dirección DEL LOCAL, no cobertura de envío.
  if (/\b(retirar|retiro|pasar a buscar|paso a buscar)\b/.test(n)) return false;
  // Seguimiento de un pedido EXISTENTE (eso no es una consulta de cobertura previa a la compra).
  if (/\bmis? (pedidos?|ordenes?|orden|compras?|paquetes?)\b/.test(n)) return false;
  if (/\bestado del? (pedido|orden|envio|compra)\b/.test(n)) return false;
  // Performance/packaging de producto ("llega a durar/proyectarse", "llega en su caja"), no logística.
  if (/\bllegan? a (durar|ser|tener|oler|proyectar|costar|valer|rendir)(se)?\b/.test(n)) return false;
  if (/\bllegan? en (su\s+|la\s+|el\s+)?(caja|estuche|envoltorio|empaque|bolsa)\b/.test(n)) return false;
  // Cita del claim de un anuncio con intención de COMPRA ("quiero la promo con envío gratis"):
  // la conversión gana; si además pregunta ("¿es gratis el envío?"), los patrones de costo aplican.
  const compraDeOferta = /\b(quiero|quisiera|dame|me llevo|compro|comprar)\s+(el|la|los|las|ese|esa|un|una)?\s*(promo(cion)?|producto|perfume|combo|pack|oferta)\b/.test(n);

  // ---- Intención logística ----
  // "¿Hacen envíos?" / "¿tienen delivery?" — genérico: sin política estructurada NO se afirma nada.
  if (/\b(hacen|haces|tienen|tenes|realizan|ofrecen|hay)\s+(envios?|delivery|entregas?( a domicilio)?)\b/.test(n)) return true;
  if (/\benvios?\s+hacen\b/.test(n) || /\b(y\s+el|como\s+es\s+el|tienen)\s+delivery\b/.test(n)) return true;
  // "envíos al interior / hasta X / para X".
  if (/\benvios?\s+(al?|a la|hasta|para)\s+\S+/.test(n)) return true;
  // "¿llegan/envían/mandan/entregan/reparten/llevan a/al <lugar>?".
  if (/\b(llegan?|envian?|mandan?|entregan?|reparten?|llevan?)\s+(al?|hasta|para|en)\s+\S+/.test(n)) return true;
  if (/\bhasta\s+donde\s+(llegan|envian|entregan|reparten|van)\b/.test(n)) return true;
  // "¿pueden enviarlo/entregarlo a/al <lugar>?" / "disponibilidad para entregar en <lugar>".
  if (/\b(pueden?|podes|podrian?)\s+(enviar|mandar|llevar|entregar)/.test(n) && /\b(al?|hasta|para|en)\s+\S+/.test(n)) return true;
  if (/\b(enviar|entregar|llevar|repartir)(lo|la|los|las|melo|mela)?\s+(al?|en|hasta|para)\s+\S+/.test(n)) return true;
  // "¿envían por encomienda/flota/correo?"
  if (/\b(envian?|mandan?|entregan?|llega)\s+(por|x)\s+(encomienda|flota|courier|correo|moto|delivery)\b/.test(n)) return true;
  // "cobertura" SOLO con contexto de envío/ubicación (la "cobertura" de una base de maquillaje no).
  if (/\bcobertura\b/.test(n) && /\b(envio|delivery|entrega|zona|barrio|ciudad|interior|ubicacion|direccion|domicilio|llegan?|tienen|hay)\b/.test(n)) return true;
  // Zonas de envío/reparto.
  if (/\bzonas?\b/.test(n) && /\b(envio|entrega|delivery|reparto|cobertura|cubren|llegan|disponibles?)\b/.test(n)) return true;
  if (/\b(que|cuales)\s+zonas?\b/.test(n)) return true;
  if (/\bcubren\b/.test(n) && /\b(zona|barrio|ciudad|area|interior)\b/.test(n)) return true;
  // Costo del envío.
  if (/\b(cuanto|precio|costo|cuesta|sale|vale|cobran)\b/.test(n) && /\b(envios?|delivery|entrega|mandar|enviar|llevar)\b/.test(n)) return true;
  if (!compraDeOferta && (/\benvios?\s+(es\s+|sale\s+|viene\s+)?(gratis|gratuito|incluido)\b/.test(n) || /\b(gratis|gratuito)\s+el\s+envio\b/.test(n))) return true;
  // Plazo de entrega (con contexto de llegar/envío — "cuánto tarda en hacer efecto" no es logística).
  if (/\bcuanto\s+(tarda|demora|tiempo)\b/.test(n) && /\b(llegar|llega|llegue|envio|entrega|entregar|enviar)\b/.test(n)) return true;
  if (/\bdemora\b/.test(n) && /\b(envio|entrega|delivery|llegar|llega)\b/.test(n)) return true;
  if (/\ben\s+cuantos?\s+(dias|horas)\b/.test(n) && /\b(llega|llegaria|entregan?|envian?)\b/.test(n)) return true;
  if (/\bsi\s+pido\s+(hoy|ahora|ya)\b/.test(n) && /\bllega\b/.test(n)) return true;
  if (/\b(tiempo|plazo|demora)\s+de\s+(entrega|envio)\b/.test(n)) return true;

  return false;
}
