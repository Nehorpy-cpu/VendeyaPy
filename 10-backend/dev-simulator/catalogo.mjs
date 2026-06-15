/**
 * catalogo.mjs — Catálogo demo + tool de búsqueda (RAG)
 * =====================================================
 * Reusa el conocimiento de negocio de Arfagi: marcas por rango de precio,
 * géneros, estilos. En el sistema real esto vive en Firestore y la búsqueda
 * es vectorial; acá es búsqueda por filtros + keywords (suficiente para el demo).
 *
 * Esta es la "tool" que el cerebro (LLM) puede invocar — el equivalente a
 * consultar_catalogo_rag de Arfagi.
 */

// Rangos de precio en Guaraníes (espeja la arquitectura de Arfagi)
export const RANGOS = {
  ACCESIBLE: [0, 250000],
  MID: [250001, 500000],
  PREMIUM: [500001, 800000],
  LUJO: [800001, 99999999],
};

// Catálogo demo (12 productos representativos de los rangos de Arfagi)
export const CATALOGO = [
  { sku: 'CH-GG-80', nombre: 'Good Girl', marca: 'Carolina Herrera', genero: 'Femenino', precio: 565000, rango: 'PREMIUM', estilos: ['intenso', 'dulce', 'floral'], stock: 4, destacado: true,  nuevo: false },
  { sku: 'LAN-LVB-50', nombre: 'La Vie Est Belle', marca: 'Lancôme', genero: 'Femenino', precio: 650000, rango: 'PREMIUM', estilos: ['dulce', 'floral', 'gourmand'], stock: 3, destacado: true, nuevo: false },
  { sku: 'YSL-BO-90', nombre: 'Black Opium', marca: 'YSL', genero: 'Femenino', precio: 690000, rango: 'PREMIUM', estilos: ['dulce', 'intenso', 'gourmand'], stock: 2, destacado: false, nuevo: false },
  { sku: 'PR-OL-50', nombre: 'Olympéa', marca: 'Paco Rabanne', genero: 'Femenino', precio: 520000, rango: 'PREMIUM', estilos: ['dulce', 'floral', 'salado'], stock: 8, destacado: false, nuevo: false },
  { sku: 'GIV-IRR-50', nombre: 'Irresistible', marca: 'Givenchy', genero: 'Femenino', precio: 700000, rango: 'PREMIUM', estilos: ['floral', 'fresco'], stock: 6, destacado: true, nuevo: false },
  { sku: 'LAT-YARA', nombre: 'Yara', marca: 'Lattafa', genero: 'Femenino', precio: 180000, rango: 'ACCESIBLE', estilos: ['dulce', 'árabe', 'gourmand'], stock: 15, destacado: true, nuevo: true },
  { sku: 'VS-BOMB', nombre: 'Bombshell', marca: "Victoria's Secret", genero: 'Femenino', precio: 220000, rango: 'ACCESIBLE', estilos: ['floral', 'fresco', 'frutal'], stock: 10, destacado: false, nuevo: false },
  { sku: 'SHAK-DANCE', nombre: 'Dance', marca: 'Shakira', genero: 'Femenino', precio: 130000, rango: 'ACCESIBLE', estilos: ['dulce', 'frutal'], stock: 20, destacado: false, nuevo: false },
  { sku: 'CK-EUPH', nombre: 'Euphoria', marca: 'Calvin Klein', genero: 'Femenino', precio: 420000, rango: 'MID', estilos: ['intenso', 'oriental'], stock: 5, destacado: false, nuevo: false },
  { sku: 'DG-LIGHT', nombre: 'Light Blue', marca: 'Dolce & Gabbana', genero: 'Femenino', precio: 480000, rango: 'MID', estilos: ['fresco', 'cítrico', 'floral'], stock: 7, destacado: false, nuevo: false },
  { sku: 'AFN-9PM', nombre: '9PM Elixir', marca: 'Afnan', genero: 'Unisex', precio: 240000, rango: 'ACCESIBLE', estilos: ['dulce', 'árabe', 'intenso'], stock: 12, destacado: true, nuevo: true },
  { sku: 'NR-NR', nombre: 'For Her', marca: 'Narciso Rodriguez', genero: 'Femenino', precio: 610000, rango: 'PREMIUM', estilos: ['amaderado', 'floral', 'sensual'], stock: 3, destacado: false, nuevo: false },
];

export const formatearGs = (n) => '₲ ' + n.toLocaleString('es-PY');

/**
 * Tool: consultar_catalogo
 * El cerebro la invoca con filtros. Devuelve productos disponibles ordenados
 * por relevancia. Equivalente a consultar_catalogo_rag de Arfagi.
 */
export function consultarCatalogo({ estilo, genero, rango_precio, precio_max, max_resultados = 3 } = {}) {
  let candidatos = CATALOGO.filter((p) => p.stock > 0);

  if (genero) candidatos = candidatos.filter((p) => p.genero === genero || p.genero === 'Unisex');
  if (rango_precio && RANGOS[rango_precio]) {
    const [min, max] = RANGOS[rango_precio];
    candidatos = candidatos.filter((p) => p.precio >= min && p.precio <= max);
  }
  if (precio_max) candidatos = candidatos.filter((p) => p.precio <= precio_max);

  // Score por estilo + bonus destacado/nuevo (aproxima la relevancia semántica)
  const scored = candidatos.map((p) => {
    let score = 0;
    if (estilo && p.estilos.includes(estilo)) score += 5;
    if (p.destacado) score += 1;
    if (p.nuevo) score += 0.5;
    return { ...p, _score: score };
  });

  scored.sort((a, b) => b._score - a._score || b.destacado - a.destacado);

  return scored.slice(0, max_resultados).map((p) => ({
    sku: p.sku,
    nombre: p.nombre,
    marca: p.marca,
    precio: p.precio,
    precio_fmt: formatearGs(p.precio),
    stock: p.stock,
    stock_critico: p.stock <= 3,
    destacado: p.destacado,
    nuevo: p.nuevo,
    estilos: p.estilos,
  }));
}

// Schema de la tool (formato compatible con Anthropic tool-use / OpenAI function-calling)
export const SCHEMA_CONSULTAR_CATALOGO = {
  name: 'consultar_catalogo',
  description:
    'Busca perfumes en el catálogo según estilo, género y presupuesto. ' +
    'Llamar cuando la clienta describe lo que busca (para quién, qué estilo, cuánto quiere gastar).',
  input_schema: {
    type: 'object',
    properties: {
      estilo: { type: 'string', enum: ['dulce', 'floral', 'fresco', 'intenso', 'árabe', 'cítrico', 'gourmand', 'amaderado', 'frutal'] },
      genero: { type: 'string', enum: ['Femenino', 'Masculino', 'Unisex'] },
      rango_precio: { type: 'string', enum: ['ACCESIBLE', 'MID', 'PREMIUM', 'LUJO'] },
      precio_max: { type: 'integer', description: 'Presupuesto máximo en Guaraníes' },
      max_resultados: { type: 'integer', default: 3 },
    },
  },
};
