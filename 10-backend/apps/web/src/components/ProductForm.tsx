'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Product, Category, ProductAiFicha } from '@vpw/shared';
import { aiFichaQuality, composeAiNotesFromFicha, composeDescriptionFromFicha, AI_FICHA_LEVEL_LABEL } from '@vpw/shared';
import type { CatalogOwnershipStatus, ProductInput } from '@/lib/catalog';
import {
  camposGobernadosCambiados,
  camposGobernadosPorFuente,
  nombreFuentePublicadora,
} from '@/lib/catalogAuthority';
import { etiquetaCampo, type CampoPublico } from '@/lib/catalogOwnership';
import { ConfirmModal } from '@/components/ui';

const GENDERS = ['Femenino', 'Masculino', 'Unisex'] as const;
const STATUSES: Array<{ value: Product['status']; label: string }> = [
  { value: 'ACTIVE', label: 'Activo (el bot lo ofrece)' },
  { value: 'INACTIVE', label: 'Inactivo (oculto)' },
  { value: 'ARCHIVED', label: 'Archivado (dado de baja)' },
];
const CONCENTRACIONES = ['', 'EDT', 'EDP', 'Extrait', 'Parfum', 'Body Mist', 'Otro'] as const;
const PROYECCIONES = ['', 'suave', 'moderada', 'fuerte'] as const;

const NIVEL_TONO: Record<string, string> = {
  incompleto: 'bg-coral-50 text-coral-700 border-coral-200',
  basico: 'bg-amber-50 text-amber-700 border-amber-200',
  bueno: 'bg-sky-50 text-sky-700 border-sky-200',
  excelente: 'bg-mint-50 text-mint-700 border-mint-200',
};

function priceRangeFromPrice(p: number): 'ACCESIBLE' | 'MID' | 'PREMIUM' | 'LUJO' {
  if (p <= 250000) return 'ACCESIBLE';
  if (p <= 500000) return 'MID';
  if (p <= 800000) return 'PREMIUM';
  return 'LUJO';
}

const csv = (s: string) => s.split(/[;,]/).map((x) => x.trim()).filter(Boolean);

/**
 * ¿La categoría es de perfumería? Decide si un producto NUEVO muestra la ficha de la
 * vertical (los existentes se deciden por su dato: `perfume != null`). Heurística por
 * nombre/id — la ficha jamás se fabrica sola: solo cambia qué campos se OFRECEN.
 */
function categoriaEsPerfumeria(cat: Category | undefined): boolean {
  if (!cat) return false;
  // NFD + quitar diacríticos (rango U+0300–U+036F): "Perfumería" → "perfumeria".
  const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return norm(`${cat.name} ${cat.id}`).includes('perfum');
}

interface Props {
  initial: Product | null;
  /** Costo del producto a editar (vive en productFinancials, no en el producto). */
  initialCost: number | null;
  /** Prioridad de venta (Modo Ganancia) — también en productFinancials. */
  initialPriority: number | null;
  categories: Category[];
  /**
   * Propiedad del catálogo (ADR-0015/ADR-0022): con una fuente externa gobernando campos
   * públicos, esos campos avisan quién los controla y editar uno exige confirmación
   * explícita (el cambio queda local, no se publica). null/ausente = sin gobierno externo.
   */
  ownership?: CatalogOwnershipStatus | null;
  onCancel: () => void;
  onSubmit: (input: ProductInput) => void;
  saving: boolean;
  /** Error del guardado (callable productUpsert): cuota, permiso, validación. */
  error?: string | null;
}

export function ProductForm({ initial, initialCost, initialPriority, categories, ownership = null, onCancel, onSubmit, saving, error }: Props) {
  const uid = useId();
  const id = (k: string) => `${uid}-${k}`;
  // --- Campos públicos gobernados por la fuente externa (ADR-0022 §4, edición honesta) ---
  const gobernados = useMemo(() => camposGobernadosPorFuente(ownership), [ownership]);
  const fuente = nombreFuentePublicadora(ownership) || 'tu propio sistema';
  const gob = (c: CampoPublico) => gobernados.includes(c);
  /**
   * Mitigación del fail-open (hallazgo B3): con `ownership === null` (la consulta de
   * propiedad está cargando o falló) los avisos específicos no existen — `gobernados` queda
   * vacío. Si el producto YA tiene identidad remota, se avisa genérico en vez de callar;
   * la confirmación específica no se puede exigir sin saber quién gobierna qué, pero el
   * guard del server sigue bloqueando el envío y la venta igual (fail-closed real).
   */
  const propiedadIlegible =
    ownership == null && !!initial && (initial.metaRetailerId != null || initial.syncToMeta === true);
  /** Confirmación pendiente: qué campos gobernados cambió este guardado, y el input listo. */
  const [confirmGobernado, setConfirmGobernado] = useState<{ etiquetas: string[]; input: ProductInput } | null>(null);
  const avisoGobernado = (campo: CampoPublico) =>
    gob(campo) ? (
      <p className="mt-1 text-xs text-amber-700">
        Este dato lo publica {fuente}: se corrige allá. Lo que edites acá queda local y no se publica.
      </p>
    ) : null;
  const pf = initial?.perfume ?? null;
  // `brand` neutral (campo nuevo del programa): si el producto viejo solo tiene la marca
  // adentro de `perfume`, se precarga de ahí — un solo campo "Marca" para cualquier rubro.
  const brandInicial = initial?.brand ?? pf?.brand ?? '';
  const categoriaInicial = initial?.categoryId ?? (categories[0]?.id ?? '');
  const [f, setF] = useState({
    name: initial?.name ?? '',
    brand: brandInicial,
    sku: initial?.inventory?.sku ?? '',
    categoryId: categoriaInicial,
    price: initial?.price ?? 0,
    // Se precarga para que guardar SIN tocarlo lo preserve (antes se pisaba con null).
    compareAtPrice: initial?.compareAtPrice ?? 0,
    costPrice: initialCost ?? 0,
    priorityScore: initialPriority ?? 0,
    stock: initial?.inventory?.stock ?? 0,
    // Un importado nace con trackStock:false — guardarlo no debe "activarle" el control.
    trackStock: initial ? initial.inventory?.trackStock === true : true,
    lowStockThreshold: initial ? (initial.inventory?.lowStockThreshold ?? 0) : 3,
    status: initial?.status ?? ('ACTIVE' as Product['status']),
    featured: initial?.featured ?? false,
    emoji: initial?.emoji ?? (categoriaEsPerfumeria(categories.find((c) => c.id === categoriaInicial)) ? '🌸' : '🛍️'),
    imagesText: (initial?.images ?? []).join('\n'),
    productUrl: initial?.productUrl ?? '',
    description: initial?.description ?? '',
    aiNotes: initial?.aiNotes ?? '',
    gender: pf?.gender ?? ('Femenino' as (typeof GENDERS)[number]),
    olfactiveFamily: pf?.olfactiveFamily ?? '',
    styleTags: (pf?.styleTags ?? []).join(', '),
    notesTop: (pf?.notes?.top ?? []).join(', '),
    notesHeart: (pf?.notes?.heart ?? []).join(', '),
    notesBase: (pf?.notes?.base ?? []).join(', '),
    sizeMl: pf?.sizeMl ?? 0,
    isNew: pf?.isNew ?? false,
    // --- Ficha para recomendaciones (CAT-1) ---
    concentracion: initial?.aiFicha?.concentracion ?? '',
    duracion: initial?.aiFicha?.duracion ?? '',
    proyeccion: initial?.aiFicha?.proyeccion ?? '',
    ocasiones: (initial?.aiFicha?.ocasiones ?? []).join(', '),
    clima: (initial?.aiFicha?.clima ?? []).join(', '),
    perfil: initial?.aiFicha?.perfil ?? '',
    cuandoRecomendar: initial?.aiFicha?.cuandoRecomendar ?? '',
    cuandoNoRecomendar: initial?.aiFicha?.cuandoNoRecomendar ?? '',
    objeciones: initial?.aiFicha?.objeciones ?? '',
    frasesVenta: (initial?.aiFicha?.frasesVenta ?? []).join('; '),
    similares: (initial?.aiFicha?.similares ?? []).join(', '),
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));

  // La ficha de la vertical se decide por el DATO al editar (perfume != null) y por la
  // categoría elegida al crear: un producto genérico no muestra campos de perfumería.
  const esPerfume = initial
    ? initial.perfume != null
    : categoriaEsPerfumeria(categories.find((c) => c.id === f.categoryId));

  // --- Accesibilidad del diálogo: foco inicial, devolución de foco y Escape ---
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const previo = document.activeElement as HTMLElement | null;
    nameRef.current?.focus();
    return () => previo?.focus?.();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape cierra igual que "Cancelar" (no durante el guardado: sería mentir el estado).
      // Con la confirmación de campo gobernado abierta, Escape la cierra a ELLA (su propio
      // handler), no al formulario entero de abajo.
      if (e.key === 'Escape' && !saving && !confirmGobernado) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saving, confirmGobernado]);

  const buildFicha = (): ProductAiFicha => ({
    ...(f.cuandoRecomendar.trim() ? { cuandoRecomendar: f.cuandoRecomendar.trim() } : {}),
    ...(f.cuandoNoRecomendar.trim() ? { cuandoNoRecomendar: f.cuandoNoRecomendar.trim() } : {}),
    ...(f.objeciones.trim() ? { objeciones: f.objeciones.trim() } : {}),
    ...(f.frasesVenta.trim() ? { frasesVenta: f.frasesVenta.split(';').map((x) => x.trim()).filter(Boolean) } : {}),
    ...(f.similares.trim() ? { similares: csv(f.similares) } : {}),
    ...(esPerfume && f.concentracion ? { concentracion: f.concentracion } : {}),
    ...(esPerfume && f.duracion.trim() ? { duracion: f.duracion.trim() } : {}),
    ...(esPerfume && f.proyeccion ? { proyeccion: f.proyeccion } : {}),
    ...(esPerfume && f.ocasiones.trim() ? { ocasiones: csv(f.ocasiones) } : {}),
    ...(esPerfume && f.clima.trim() ? { clima: csv(f.clima) } : {}),
    ...(esPerfume && f.perfil.trim() ? { perfil: f.perfil.trim() } : {}),
  });

  // Vista previa del producto tal como quedaría → nivel de calidad EN VIVO.
  const calidad = useMemo(() => aiFichaQuality({
    description: f.description,
    aiNotes: f.aiNotes,
    perfume: esPerfume
      ? { olfactiveFamily: f.olfactiveFamily, styleTags: csv(f.styleTags), sizeMl: f.sizeMl ? Number(f.sizeMl) : null,
          notes: { top: csv(f.notesTop), heart: csv(f.notesHeart), base: csv(f.notesBase) } }
      : null,
    aiFicha: buildFicha(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [f, esPerfume]);

  /** Rellena aiNotes (y description si está vacía) desde la ficha — plantilla, SIN IA externa. */
  const generarDesdeFicha = () => {
    const base = {
      name: f.name,
      description: f.description,
      aiNotes: f.aiNotes,
      perfume: esPerfume
        ? { olfactiveFamily: f.olfactiveFamily, styleTags: csv(f.styleTags), sizeMl: f.sizeMl ? Number(f.sizeMl) : null,
            notes: { top: csv(f.notesTop), heart: csv(f.notesHeart), base: csv(f.notesBase) } }
        : null,
      aiFicha: buildFicha(),
    };
    const notas = composeAiNotesFromFicha(base);
    const desc = composeDescriptionFromFicha(base);
    setF((s) => ({
      ...s,
      aiNotes: notas || s.aiNotes,
      description: s.description.trim() ? s.description : (desc || s.description),
    }));
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // Ficha vacía → null (no guardar `{}` en Firestore).
    const ficha = buildFicha();
    const input: ProductInput = {
      ...(initial ? { id: initial.id } : {}),
      name: f.name.trim(),
      brand: f.brand.trim(),
      description: f.description.trim(),
      price: Number(f.price) || 0,
      compareAtPrice: f.compareAtPrice ? Number(f.compareAtPrice) : null,
      costPrice: f.costPrice ? Number(f.costPrice) : null,
      priorityScore: f.priorityScore ? Number(f.priorityScore) : null,
      aiNotes: f.aiNotes.trim(),
      categoryId: f.categoryId,
      images: f.imagesText.split(/\n+/).map((u) => u.trim()).filter(Boolean),
      emoji: f.emoji,
      stock: Number(f.stock) || 0,
      trackStock: f.trackStock,
      lowStockThreshold: Number(f.lowStockThreshold) || 0,
      sku: f.sku.trim() || f.name.trim().toLowerCase().replace(/\s+/g, '-'),
      status: f.status,
      featured: f.featured,
      productUrl: f.productUrl.trim(),
      // Un producto genérico sigue siendo genérico al editarlo (si mandáramos el objeto
      // perfume, el badge de la lista pasaría a exigir las señales de perfumería).
      // La marca del perfume se espeja del campo neutral: UN solo lugar para cargarla.
      perfume: esPerfume ? {
        brand: f.brand.trim(),
        gender: f.gender,
        olfactiveFamily: f.olfactiveFamily.trim(),
        styleTags: csv(f.styleTags),
        notes: { top: csv(f.notesTop), heart: csv(f.notesHeart), base: csv(f.notesBase) },
        priceRange: priceRangeFromPrice(Number(f.price) || 0),
        sizeMl: f.sizeMl ? Number(f.sizeMl) : null,
        isNew: f.isNew,
      } : null,
      aiFicha: Object.keys(ficha).length ? ficha : null,
    };
    // ADR-0022 §4 (caso Odyssey): editar un campo que publica otra fuente JAMÁS se guarda en
    // silencio — se confirma explicando que el cambio queda local y puede marcar deriva.
    // Un producto NUEVO todavía no existe publicado: no hay deriva posible que confirmar.
    const cambiados = initial ? camposGobernadosCambiados(initial, input, gobernados) : [];
    if (cambiados.length > 0) {
      setConfirmGobernado({ etiquetas: [...new Set(cambiados.map(etiquetaCampo))], input });
      return;
    }
    onSubmit(input);
  };

  const field = 'w-full rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-800 transition-colors focus:border-mint-500 focus:outline-none focus:ring-2 focus:ring-mint-500/30';
  const lbl = 'mb-1 block text-xs font-medium text-ink-600';
  const seccion = 'rounded-xl border border-ink-100 p-4';
  const leyenda = 'px-1 text-sm font-semibold text-ink-900';
  const catConocida = categories.some((c) => c.id === f.categoryId);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4">
      <form
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id('titulo')}
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-ink-100 bg-white shadow-float"
      >
        <h2 id={id('titulo')} className="shrink-0 border-b border-ink-100 px-6 py-4 text-lg font-bold text-ink-900">
          {initial ? 'Editar producto' : 'Nuevo producto'}
        </h2>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          {/* ===== Datos públicos: lo que puede viajar a Meta y ver el cliente ===== */}
          <fieldset className={seccion}>
            <legend className={leyenda}>
              Datos públicos <span className="font-normal text-ink-500">(pueden ir a Meta y a tus clientes)</span>
            </legend>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {/* Aviso de gobierno externo (ADR-0022): quién controla estos datos y dónde se
                  corrigen — ANTES de editar, no como sorpresa al guardar. */}
              {gobernados.length > 0 && (
                <p role="status" className="sm:col-span-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  <strong>{[...new Set(gobernados.map(etiquetaCampo))].join(', ')}</strong>: estos datos publicados los
                  controla {fuente} y se corrigen allá. Lo que edites acá queda local, no se publica, y si difiere de lo
                  publicado puede bloquear la venta automática hasta que coincidan.
                </p>
              )}
              {propiedadIlegible && (
                <p role="status" className="sm:col-span-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  No pudimos verificar quién administra el catálogo publicado. Este producto existe en Meta: si lo
                  publica otro sistema, lo que edites acá puede quedar solo local y no publicarse.
                </p>
              )}
              <div className="sm:col-span-2">
                <label className={lbl} htmlFor={id('name')}>Nombre *</label>
                <input id={id('name')} ref={nameRef} className={field} required value={f.name} onChange={(e) => set('name', e.target.value)} />
                {avisoGobernado('title')}
              </div>
              <div>
                <label className={lbl} htmlFor={id('brand')}>Marca</label>
                <input id={id('brand')} className={field} value={f.brand} onChange={(e) => set('brand', e.target.value)} placeholder="Meta la exige para publicar" />
                {avisoGobernado('brand')}
              </div>
              <div>
                <label className={lbl} htmlFor={id('categoryId')}>Categoría</label>
                <select id={id('categoryId')} className={field} value={f.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
                  {/* Sin fallback inventado: si el valor actual no está en la lista (importado
                      sin clasificar o categoría borrada), se muestra tal cual para no pisarlo. */}
                  {!catConocida && (
                    <option value={f.categoryId}>{f.categoryId ? `(${f.categoryId})` : 'Sin clasificar'}</option>
                  )}
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                {!f.categoryId && (
                  <p className="mt-1 text-xs text-ink-500">Sin categoría no se puede publicar en Meta ni ordenar el catálogo.</p>
                )}
                {avisoGobernado('category')}
              </div>
              <div>
                <label className={lbl} htmlFor={id('price')}>Precio de venta (₲) *</label>
                <input id={id('price')} className={field} type="number" min={0} inputMode="numeric" required value={f.price} onChange={(e) => set('price', Number(e.target.value))} />
                {avisoGobernado('price')}
              </div>
              <div>
                <label className={lbl} htmlFor={id('compareAtPrice')}>Precio anterior (₲, tachado)</label>
                <input id={id('compareAtPrice')} className={field} type="number" min={0} inputMode="numeric" value={f.compareAtPrice} onChange={(e) => set('compareAtPrice', Number(e.target.value))} placeholder="0 = sin oferta" />
              </div>
              <div>
                <label className={lbl} htmlFor={id('currency')}>Moneda</label>
                <input id={id('currency')} className={`${field} bg-ink-50 text-ink-600`} value="PYG — guaraníes" readOnly aria-readonly="true" />
                <p className="mt-1 text-xs text-ink-500">Por ahora el catálogo trabaja solo en guaraníes.</p>
              </div>
              <div className="sm:col-span-2">
                <label className={lbl} htmlFor={id('images')}>Imágenes (una URL https por línea; la primera es la principal)</label>
                <textarea id={id('images')} className={field} rows={2} value={f.imagesText} onChange={(e) => set('imagesText', e.target.value)} placeholder={'https://…\nhttps://…'} />
                {avisoGobernado('image')}
              </div>
              <div className="sm:col-span-2">
                <label className={lbl} htmlFor={id('productUrl')}>Enlace al producto (URL)</label>
                <input
                  id={id('productUrl')}
                  className={field}
                  type="url"
                  value={f.productUrl}
                  onChange={(e) => set('productUrl', e.target.value)}
                  placeholder="https://tutienda.com/producto"
                />
                <p className="mt-1 text-xs text-ink-500">Meta lo exige para publicar el producto en el catálogo.</p>
                {avisoGobernado('url')}
              </div>
              <div className="sm:col-span-2">
                <label className={lbl} htmlFor={id('description')}>Descripción</label>
                <textarea id={id('description')} className={field} rows={2} value={f.description} onChange={(e) => set('description', e.target.value)} />
                {avisoGobernado('description')}
              </div>
            </div>
          </fieldset>

          {/* ===== Datos internos: nunca se publican ===== */}
          <fieldset className={seccion}>
            <legend className={leyenda}>
              Datos internos <span className="font-normal text-ink-500">(solo los ve tu equipo)</span>
            </legend>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className={lbl} htmlFor={id('sku')}>SKU / código</label>
                <input id={id('sku')} className={field} value={f.sku} onChange={(e) => set('sku', e.target.value)} placeholder="(auto si vacío)" />
              </div>
              <div>
                <label className={lbl} htmlFor={id('status')}>Estado</label>
                <select id={id('status')} className={field} value={f.status} onChange={(e) => set('status', e.target.value as Product['status'])}>
                  {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
              <div>
                <label className={lbl} htmlFor={id('costPrice')}>Precio de costo (₲)</label>
                <input id={id('costPrice')} className={field} type="number" min={0} inputMode="numeric" value={f.costPrice} onChange={(e) => set('costPrice', Number(e.target.value))} placeholder="para calcular ganancia" />
              </div>
              <div>
                <label className={lbl} htmlFor={id('priorityScore')}>Prioridad de venta (0-10)</label>
                <input id={id('priorityScore')} className={field} type="number" min={0} max={10} inputMode="numeric" value={f.priorityScore} onChange={(e) => set('priorityScore', Number(e.target.value))} placeholder="Modo Ganancia: empujar este producto" />
              </div>
              <div>
                <label className={lbl} htmlFor={id('stock')}>Stock</label>
                <input id={id('stock')} className={field} type="number" min={0} inputMode="numeric" value={f.stock} onChange={(e) => set('stock', Number(e.target.value))} />
                {/* El stock es interno, pero la DISPONIBILIDAD publicada sale de él. */}
                {(gob('inventory') || gob('availability')) && (
                  <p className="mt-1 text-xs text-amber-700">
                    La disponibilidad publicada la controla {fuente}: tu stock de acá queda local y no se publica.
                  </p>
                )}
              </div>
              <div>
                <label className={lbl} htmlFor={id('lowStockThreshold')}>Aviso de stock bajo (unidades)</label>
                <input
                  id={id('lowStockThreshold')}
                  className={field}
                  type="number"
                  min={0}
                  inputMode="numeric"
                  value={f.lowStockThreshold}
                  onChange={(e) => set('lowStockThreshold', Number(e.target.value))}
                  disabled={!f.trackStock}
                />
              </div>
              <label className="flex items-center gap-2 text-sm text-ink-700" htmlFor={id('trackStock')}>
                <input id={id('trackStock')} type="checkbox" className="accent-mint-600" checked={f.trackStock} onChange={(e) => set('trackStock', e.target.checked)} />
                Controlar stock (sin control, el bot vende sin mirar cantidades)
              </label>
              <div>
                <label className={lbl} htmlFor={id('emoji')}>Emoji (se muestra en la lista y en el chat)</label>
                <input id={id('emoji')} className={field} maxLength={4} value={f.emoji} onChange={(e) => set('emoji', e.target.value)} />
              </div>
              {initial?.stockPendingReview === true && (
                <p role="status" className="sm:col-span-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  Este producto se importó de Meta y su stock todavía no fue revisado. Al guardar con el
                  inventario correcto queda marcado como revisado.
                </p>
              )}
              <label className="flex items-center gap-2 text-sm text-ink-700" htmlFor={id('featured')}>
                <input id={id('featured')} type="checkbox" className="accent-mint-600" checked={f.featured} onChange={(e) => set('featured', e.target.checked)} /> Destacado
              </label>
              <div className="sm:col-span-2">
                <label className={lbl} htmlFor={id('aiNotes')}>Notas para la IA (el agente las usa para recomendar)</label>
                <p className="mb-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  ⚠️ Este contenido puede ser usado por el bot al responder a clientes. No incluyas costos, márgenes, datos internos, campañas privadas ni información sensible.
                </p>
                <textarea id={id('aiNotes')} className={field} rows={2} value={f.aiNotes} onChange={(e) => set('aiNotes', e.target.value)} placeholder="Beneficios, público ideal, cuándo recomendarlo…" />
              </div>
            </div>
          </fieldset>

          {/* ===== Ficha de la vertical (solo si el producto ES de perfumería) ===== */}
          {esPerfume && (
            <fieldset className={seccion}>
              <legend className={leyenda}>
                Ficha de perfumería <span className="font-normal text-ink-500">(este producto es un perfume)</span>
              </legend>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className={lbl} htmlFor={id('gender')}>Género</label>
                  <select id={id('gender')} className={field} value={f.gender} onChange={(e) => set('gender', e.target.value as (typeof GENDERS)[number])}>
                    {GENDERS.map((g) => <option key={g} value={g}>{g}</option>)}
                  </select>
                </div>
                <div>
                  <label className={lbl} htmlFor={id('olfactiveFamily')}>Familia olfativa</label>
                  <input id={id('olfactiveFamily')} className={field} value={f.olfactiveFamily} onChange={(e) => set('olfactiveFamily', e.target.value)} placeholder="Floral, Oriental…" />
                </div>
                <div>
                  <label className={lbl} htmlFor={id('sizeMl')}>Tamaño (ml)</label>
                  <input id={id('sizeMl')} className={field} type="number" min={0} inputMode="numeric" value={f.sizeMl} onChange={(e) => set('sizeMl', Number(e.target.value))} />
                </div>
                <label className="flex items-center gap-2 self-end pb-2 text-sm text-ink-700" htmlFor={id('isNew')}>
                  <input id={id('isNew')} type="checkbox" className="accent-mint-600" checked={f.isNew} onChange={(e) => set('isNew', e.target.checked)} /> Nuevo
                </label>
                <div className="sm:col-span-2">
                  <label className={lbl} htmlFor={id('styleTags')}>Estilos (separá con coma)</label>
                  <input id={id('styleTags')} className={field} value={f.styleTags} onChange={(e) => set('styleTags', e.target.value)} placeholder="dulce, floral, intenso" />
                </div>
                <div>
                  <label className={lbl} htmlFor={id('notesTop')}>Notas de salida</label>
                  <input id={id('notesTop')} className={field} value={f.notesTop} onChange={(e) => set('notesTop', e.target.value)} />
                </div>
                <div>
                  <label className={lbl} htmlFor={id('notesHeart')}>Notas de corazón</label>
                  <input id={id('notesHeart')} className={field} value={f.notesHeart} onChange={(e) => set('notesHeart', e.target.value)} />
                </div>
                <div>
                  <label className={lbl} htmlFor={id('notesBase')}>Notas de fondo</label>
                  <input id={id('notesBase')} className={field} value={f.notesBase} onChange={(e) => set('notesBase', e.target.value)} />
                </div>
              </div>
            </fieldset>
          )}

          {/* ===== Ficha para recomendaciones (CAT-1) ===== */}
          <div className="rounded-xl border border-ink-100 bg-ink-50/40 p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-ink-900">Ficha para recomendaciones</h3>
                <p className="text-xs text-ink-500">Opcional para vender, pero el agente recomienda mucho mejor si está completa.</p>
              </div>
              <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${NIVEL_TONO[calidad.level]}`} title={calidad.faltantes.length ? 'Falta: ' + calidad.faltantes.slice(0, 5).join(', ') : 'Ficha completa'}>
                {AI_FICHA_LEVEL_LABEL[calidad.level]} · {calidad.score}/{calidad.total}
              </span>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {esPerfume && (
                <>
                  <div>
                    <label className={lbl} htmlFor={id('concentracion')}>Concentración</label>
                    <select id={id('concentracion')} className={field} value={f.concentracion} onChange={(e) => set('concentracion', e.target.value)}>
                      {CONCENTRACIONES.map((c) => <option key={c} value={c}>{c || '—'}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={lbl} htmlFor={id('duracion')}>Duración</label>
                    <input id={id('duracion')} className={field} value={f.duracion} onChange={(e) => set('duracion', e.target.value)} placeholder="6-8 horas" />
                  </div>
                  <div>
                    <label className={lbl} htmlFor={id('proyeccion')}>Proyección</label>
                    <select id={id('proyeccion')} className={field} value={f.proyeccion} onChange={(e) => set('proyeccion', e.target.value)}>
                      {PROYECCIONES.map((p) => <option key={p} value={p}>{p || '—'}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={lbl} htmlFor={id('ocasiones')}>Ocasiones (coma)</label>
                    <input id={id('ocasiones')} className={field} value={f.ocasiones} onChange={(e) => set('ocasiones', e.target.value)} placeholder="cita, fiesta, diario" />
                  </div>
                  <div>
                    <label className={lbl} htmlFor={id('clima')}>Clima (coma)</label>
                    <input id={id('clima')} className={field} value={f.clima} onChange={(e) => set('clima', e.target.value)} placeholder="invierno, todo el año" />
                  </div>
                  <div>
                    <label className={lbl} htmlFor={id('perfil')}>Perfil recomendado</label>
                    <input id={id('perfil')} className={field} value={f.perfil} onChange={(e) => set('perfil', e.target.value)} placeholder="juvenil, elegante…" />
                  </div>
                </>
              )}
              <div className="sm:col-span-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={lbl} htmlFor={id('cuandoRecomendar')}>Cuándo recomendarlo</label>
                  <input id={id('cuandoRecomendar')} className={field} value={f.cuandoRecomendar} onChange={(e) => set('cuandoRecomendar', e.target.value)} placeholder="busca duración y presencia" />
                </div>
                <div>
                  <label className={lbl} htmlFor={id('cuandoNoRecomendar')}>Cuándo NO recomendarlo</label>
                  <input id={id('cuandoNoRecomendar')} className={field} value={f.cuandoNoRecomendar} onChange={(e) => set('cuandoNoRecomendar', e.target.value)} placeholder="quiere algo suave para oficina" />
                </div>
                <div>
                  <label className={lbl} htmlFor={id('objeciones')}>Objeciones frecuentes (y cómo responder)</label>
                  <input id={id('objeciones')} className={field} value={f.objeciones} onChange={(e) => set('objeciones', e.target.value)} placeholder='"es caro" → rinde como uno de lujo' />
                </div>
                <div>
                  <label className={lbl} htmlFor={id('similares')}>Similares / alternativas (coma)</label>
                  <input id={id('similares')} className={field} value={f.similares} onChange={(e) => set('similares', e.target.value)} placeholder="Odyssey Mega, Asad" />
                </div>
                <div className="sm:col-span-2">
                  <label className={lbl} htmlFor={id('frasesVenta')}>Frases de venta sugeridas (separá con ;)</label>
                  <input id={id('frasesVenta')} className={field} value={f.frasesVenta} onChange={(e) => set('frasesVenta', e.target.value)} placeholder="Rendimiento de gama alta a precio accesible; El favorito para regalar" />
                </div>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button type="button" onClick={generarDesdeFicha} className="rounded-lg border border-mint-300 bg-mint-50 px-3 py-1.5 text-xs font-semibold text-mint-700 transition-colors hover:bg-mint-100">
                ✨ Generar “Notas para la IA” desde la ficha
              </button>
              <span className="text-[11px] text-ink-500">Plantilla con TUS datos (sin IA): rellena las notas y, si está vacía, la descripción. Podés editarlas después.</span>
            </div>
          </div>

          {error && (
            <p role="alert" className="rounded-lg bg-coral-50 px-3 py-2 text-sm text-coral-700">{error}</p>
          )}
        </div>

        <div className="flex shrink-0 justify-end gap-3 border-t border-ink-100 px-6 py-4">
          <button type="button" onClick={onCancel} className="rounded-lg border border-ink-200 px-4 py-2 text-sm font-medium text-ink-700 transition-colors hover:bg-ink-50">
            Cancelar
          </button>
          <button type="submit" disabled={saving} className="rounded-lg bg-mint-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-mint-700 disabled:opacity-60">
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </form>

      {/* Confirmación de edición de campo gobernado (ADR-0022 §4). FUERA del <form>: los
          botones del modal no deben disparar el submit del formulario de abajo. */}
      {confirmGobernado && (
        <ConfirmModal
          title="Este dato lo controla otra fuente"
          confirmLabel="Guardar igual (queda local)"
          cancelLabel="Volver"
          danger
          onCancel={() => setConfirmGobernado(null)}
          onConfirm={() => {
            const input = confirmGobernado.input;
            setConfirmGobernado(null);
            onSubmit(input);
          }}
        >
          <p>
            {confirmGobernado.etiquetas.join(', ')}: {confirmGobernado.etiquetas.length === 1 ? 'este dato lo' : 'estos datos los'}{' '}
            controla {fuente}. Tu cambio queda local, <strong>no se publica</strong>, y puede marcar una diferencia con
            lo publicado que bloquee la venta automática hasta que coincidan.
          </p>
          <p className="mt-2">Para cambiar lo publicado, corregilo en {fuente}.</p>
        </ConfirmModal>
      )}
    </div>
  );
}
