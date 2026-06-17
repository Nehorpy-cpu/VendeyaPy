/**
 * import-catalogo.mjs — Importador del catálogo de perfumería
 * ===========================================================
 * Lee la plantilla CSV, valida y normaliza cada producto al formato del
 * sistema (Product + PerfumeAttributes), y produce seed-productos.json.
 *
 * USO:
 *   node import-catalogo.mjs                      → usa plantilla-catalogo.csv
 *   node import-catalogo.mjs mi-catalogo.csv      → usa otro archivo
 *
 * Hoy corre en modo "dry-run": valida y genera el JSON listo para cargar.
 * La carga real a Firestore se conecta en F3 (cuando esté el emulador/proyecto).
 * Cuando tengas tu catálogo de Meta/Instagram, exportalo a CSV y mapeás sus
 * columnas a las de la plantilla (ver README.md).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));

// Rangos de precio en Guaraníes (espeja la arquitectura)
const RANGOS = [
  ['ACCESIBLE', 0, 250000],
  ['MID', 250001, 500000],
  ['PREMIUM', 500001, 800000],
  ['LUJO', 800001, Infinity],
];
const rangoDe = (precio) => (RANGOS.find(([, min, max]) => precio >= min && precio <= max) ?? ['MID'])[0];

const slug = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const lista = (s) => (s ?? '').split(/[;,]/).map((x) => x.trim()).filter(Boolean);
const siNo = (s) => /^(si|sí|true|1|x)$/i.test((s ?? '').trim());

/** Parser CSV con manejo de comillas (campos pueden contener comas). */
function parseCSV(texto) {
  const filas = [];
  let campo = '', fila = [], enComillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (enComillas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') enComillas = false;
      else campo += c;
    } else if (c === '"') enComillas = true;
    else if (c === ',') { fila.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      if (campo !== '' || fila.length) { fila.push(campo); filas.push(fila); fila = []; campo = ''; }
    } else campo += c;
  }
  if (campo !== '' || fila.length) { fila.push(campo); filas.push(fila); }
  return filas;
}

function main() {
  const archivo = process.argv[2] || 'plantilla-catalogo.csv';
  const ruta = join(DIR, archivo);

  let texto;
  try { texto = readFileSync(ruta, 'utf-8'); }
  catch { console.error(`❌ No se encontró el archivo: ${ruta}`); process.exit(1); }

  const filas = parseCSV(texto);
  if (filas.length < 2) { console.error('❌ El CSV no tiene filas de datos.'); process.exit(1); }

  const headers = filas[0].map((h) => h.trim());
  const idx = (nombre) => headers.indexOf(nombre);
  const requeridas = ['nombre', 'marca', 'genero', 'precio_gs'];
  const faltantes = requeridas.filter((r) => idx(r) === -1);
  if (faltantes.length) { console.error(`❌ Faltan columnas requeridas: ${faltantes.join(', ')}`); process.exit(1); }

  const GENEROS = ['Femenino', 'Masculino', 'Unisex'];
  const productos = [];
  const avisos = [];

  for (let f = 1; f < filas.length; f++) {
    const fila = filas[f];
    if (fila.every((c) => c.trim() === '')) continue;
    const get = (col) => (idx(col) >= 0 ? (fila[idx(col)] ?? '').trim() : '');

    const nombre = get('nombre');
    const marca = get('marca');
    const genero = get('genero');
    const precio = parseInt(get('precio_gs').replace(/\D/g, ''), 10);

    // Validaciones
    if (!nombre || !marca) { avisos.push(`Fila ${f + 1}: sin nombre/marca → omitida`); continue; }
    if (!GENEROS.includes(genero)) { avisos.push(`Fila ${f + 1} (${nombre}): género "${genero}" inválido → omitida`); continue; }
    if (!precio || isNaN(precio)) { avisos.push(`Fila ${f + 1} (${nombre}): precio inválido → omitida`); continue; }

    const sku = get('sku') || `${slug(marca)}-${slug(nombre)}`;

    productos.push({
      id: sku,
      tenantId: 'perfumeria',
      name: nombre,
      description: get('descripcion'),
      price: precio,
      compareAtPrice: null,
      costPrice: parseInt(get('precio_costo').replace(/\D/g, ''), 10) || null,
      aiNotes: get('notas_ia'),
      currency: 'PYG',
      categoryId: 'perfumes',
      images: get('imagen_url') ? [get('imagen_url')] : [],
      emoji: '🌸',
      inventory: { trackStock: true, stock: parseInt(get('stock') || '0', 10) || 0, lowStockThreshold: 3, sku },
      status: 'ACTIVE',
      featured: siNo(get('destacado')),
      position: productos.length,
      externalIds: { facebook: null, instagram: null, tiktok: null },
      perfume: {
        brand: marca,
        gender: genero,
        olfactiveFamily: get('familia_olfativa'),
        styleTags: lista(get('estilos')),
        notes: { top: lista(get('notas_salida')), heart: lista(get('notas_corazon')), base: lista(get('notas_fondo')) },
        priceRange: rangoDe(precio),
        sizeMl: parseInt(get('tamano_ml') || '0', 10) || null,
        isNew: siNo(get('nuevo')),
      },
    });
  }

  const salida = join(DIR, 'seed-productos.json');
  writeFileSync(salida, JSON.stringify(productos, null, 2), 'utf-8');

  // Resumen
  console.log('\n═══════════════════════════════════════════');
  console.log('  IMPORTADOR DE CATÁLOGO · Perfumería AFG');
  console.log('═══════════════════════════════════════════');
  console.log(`✅ Productos válidos: ${productos.length}`);
  if (avisos.length) { console.log(`⚠️  Avisos (${avisos.length}):`); avisos.forEach((a) => console.log('   - ' + a)); }
  console.log(`\n📦 Guardado en: seed-productos.json`);
  const porRango = {};
  productos.forEach((p) => { porRango[p.perfume.priceRange] = (porRango[p.perfume.priceRange] || 0) + 1; });
  console.log('   Por rango de precio:', JSON.stringify(porRango));
  console.log('\n🔌 Próximo paso (F3): cargar este JSON al emulador de Firestore.');
  console.log('═══════════════════════════════════════════\n');
}

main();
