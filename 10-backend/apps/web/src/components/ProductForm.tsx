'use client';

import { useMemo, useState } from 'react';
import type { Product, Category, ProductAiFicha } from '@vpw/shared';
import { aiFichaQuality, composeAiNotesFromFicha, composeDescriptionFromFicha, AI_FICHA_LEVEL_LABEL } from '@vpw/shared';
import type { ProductInput } from '@/lib/catalog';

const GENDERS = ['Femenino', 'Masculino', 'Unisex'] as const;
const STATUSES: Product['status'][] = ['ACTIVE', 'INACTIVE', 'ARCHIVED'];
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

interface Props {
  initial: Product | null;
  /** Costo del producto a editar (vive en productFinancials, no en el producto). */
  initialCost: number | null;
  /** Prioridad de venta (Modo Ganancia) — también en productFinancials. */
  initialPriority: number | null;
  categories: Category[];
  onCancel: () => void;
  onSubmit: (input: ProductInput) => void;
  saving: boolean;
  /** Error del guardado (callable productUpsert): cuota, permiso, validación. */
  error?: string | null;
}

export function ProductForm({ initial, initialCost, initialPriority, categories, onCancel, onSubmit, saving, error }: Props) {
  const pf = initial?.perfume ?? null;
  const [f, setF] = useState({
    name: initial?.name ?? '',
    sku: initial?.inventory?.sku ?? '',
    categoryId: initial?.categoryId ?? (categories[0]?.id ?? 'perfumes'),
    price: initial?.price ?? 0,
    costPrice: initialCost ?? 0,
    priorityScore: initialPriority ?? 0,
    stock: initial?.inventory?.stock ?? 0,
    status: initial?.status ?? ('ACTIVE' as Product['status']),
    featured: initial?.featured ?? false,
    emoji: initial?.emoji ?? '🌸',
    imageUrl: initial?.images?.[0] ?? '',
    description: initial?.description ?? '',
    aiNotes: initial?.aiNotes ?? '',
    brand: pf?.brand ?? '',
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

  // El producto es perfume salvo que la edición diga explícitamente lo contrario (vertical actual).
  // != null cubre null y undefined, igual que aiFichaQuality — chip y badge deben coincidir.
  const esPerfume = initial ? initial.perfume != null : true;

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
      description: f.description.trim(),
      price: Number(f.price) || 0,
      costPrice: f.costPrice ? Number(f.costPrice) : null,
      priorityScore: f.priorityScore ? Number(f.priorityScore) : null,
      aiNotes: f.aiNotes.trim(),
      categoryId: f.categoryId,
      images: f.imageUrl.trim() ? [f.imageUrl.trim()] : [],
      emoji: f.emoji,
      stock: Number(f.stock) || 0,
      sku: f.sku.trim() || f.name.trim().toLowerCase().replace(/\s+/g, '-'),
      status: f.status,
      featured: f.featured,
      // Un producto genérico sigue siendo genérico al editarlo (si mandáramos el objeto
      // perfume, el badge de la lista pasaría a exigir las señales de perfumería).
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
    onSubmit(input);
  };

  const field = 'w-full rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-800 transition-colors focus:border-mint-500 focus:outline-none focus:ring-2 focus:ring-mint-500/30';
  const lbl = 'mb-1 block text-xs font-medium text-ink-600';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4">
      <form onSubmit={submit} className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-ink-100 bg-white shadow-float">
        <h2 className="shrink-0 border-b border-ink-100 px-6 py-4 text-lg font-bold text-ink-900">
          {initial ? 'Editar producto' : 'Nuevo producto'}
        </h2>

        <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={lbl}>Nombre *</label>
            <input className={field} required value={f.name} onChange={(e) => set('name', e.target.value)} />
          </div>
          {esPerfume && (
            <div>
              <label className={lbl}>Marca</label>
              <input className={field} value={f.brand} onChange={(e) => set('brand', e.target.value)} />
            </div>
          )}
          <div>
            <label className={lbl}>SKU / código</label>
            <input className={field} value={f.sku} onChange={(e) => set('sku', e.target.value)} placeholder="(auto si vacío)" />
          </div>
          <div>
            <label className={lbl}>Precio de venta (₲) *</label>
            <input className={field} type="number" required value={f.price} onChange={(e) => set('price', Number(e.target.value))} />
          </div>
          <div>
            <label className={lbl}>Precio de costo (₲)</label>
            <input className={field} type="number" value={f.costPrice} onChange={(e) => set('costPrice', Number(e.target.value))} placeholder="para calcular ganancia" />
          </div>
          <div>
            <label className={lbl}>Prioridad de venta (0-10)</label>
            <input className={field} type="number" value={f.priorityScore} onChange={(e) => set('priorityScore', Number(e.target.value))} placeholder="Modo Ganancia: empujar este producto" />
          </div>
          <div>
            <label className={lbl}>Stock</label>
            <input className={field} type="number" value={f.stock} onChange={(e) => set('stock', Number(e.target.value))} />
          </div>
          {esPerfume && (
            <div>
              <label className={lbl}>Tamaño (ml)</label>
              <input className={field} type="number" value={f.sizeMl} onChange={(e) => set('sizeMl', Number(e.target.value))} />
            </div>
          )}
          <div>
            <label className={lbl}>Categoría</label>
            <select className={field} value={f.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
              {categories.length === 0 && <option value="perfumes">perfumes</option>}
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          {esPerfume && (
            <>
              <div>
                <label className={lbl}>Género</label>
                <select className={field} value={f.gender} onChange={(e) => set('gender', e.target.value as (typeof GENDERS)[number])}>
                  {GENDERS.map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
              </div>
              <div>
                <label className={lbl}>Familia olfativa</label>
                <input className={field} value={f.olfactiveFamily} onChange={(e) => set('olfactiveFamily', e.target.value)} placeholder="Floral, Oriental…" />
              </div>
            </>
          )}
          <div>
            <label className={lbl}>Estado</label>
            <select className={field} value={f.status} onChange={(e) => set('status', e.target.value as Product['status'])}>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          {esPerfume && (
            <>
              <div className="sm:col-span-2">
                <label className={lbl}>Estilos (separá con coma)</label>
                <input className={field} value={f.styleTags} onChange={(e) => set('styleTags', e.target.value)} placeholder="dulce, floral, intenso" />
              </div>
              <div>
                <label className={lbl}>Notas de salida</label>
                <input className={field} value={f.notesTop} onChange={(e) => set('notesTop', e.target.value)} />
              </div>
              <div>
                <label className={lbl}>Notas de corazón</label>
                <input className={field} value={f.notesHeart} onChange={(e) => set('notesHeart', e.target.value)} />
              </div>
              <div>
                <label className={lbl}>Notas de fondo</label>
                <input className={field} value={f.notesBase} onChange={(e) => set('notesBase', e.target.value)} />
              </div>
            </>
          )}
          <div>
            <label className={lbl}>Imagen (URL)</label>
            <input className={field} value={f.imageUrl} onChange={(e) => set('imageUrl', e.target.value)} placeholder="https://…" />
          </div>
          <div className="sm:col-span-2">
            <label className={lbl}>Descripción</label>
            <textarea className={field} rows={2} value={f.description} onChange={(e) => set('description', e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <label className={lbl}>Notas para la IA (el agente las usa para recomendar)</label>
            <p className="mb-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              ⚠️ Este contenido puede ser usado por el bot al responder a clientes. No incluyas costos, márgenes, datos internos, campañas privadas ni información sensible.
            </p>
            <textarea className={field} rows={2} value={f.aiNotes} onChange={(e) => set('aiNotes', e.target.value)} placeholder="Beneficios, público ideal, cuándo recomendarlo…" />
          </div>
          <label className="flex items-center gap-2 text-sm text-ink-700">
            <input type="checkbox" className="accent-mint-600" checked={f.featured} onChange={(e) => set('featured', e.target.checked)} /> Destacado
          </label>
          {esPerfume && (
            <label className="flex items-center gap-2 text-sm text-ink-700">
              <input type="checkbox" className="accent-mint-600" checked={f.isNew} onChange={(e) => set('isNew', e.target.checked)} /> Nuevo
            </label>
          )}

          {/* ===== Ficha para recomendaciones (CAT-1) ===== */}
          <div className="sm:col-span-2 mt-2 rounded-xl border border-ink-100 bg-ink-50/40 p-4">
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
                    <label className={lbl}>Concentración</label>
                    <select className={field} value={f.concentracion} onChange={(e) => set('concentracion', e.target.value)}>
                      {CONCENTRACIONES.map((c) => <option key={c} value={c}>{c || '—'}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={lbl}>Duración</label>
                    <input className={field} value={f.duracion} onChange={(e) => set('duracion', e.target.value)} placeholder="6-8 horas" />
                  </div>
                  <div>
                    <label className={lbl}>Proyección</label>
                    <select className={field} value={f.proyeccion} onChange={(e) => set('proyeccion', e.target.value)}>
                      {PROYECCIONES.map((p) => <option key={p} value={p}>{p || '—'}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={lbl}>Ocasiones (coma)</label>
                    <input className={field} value={f.ocasiones} onChange={(e) => set('ocasiones', e.target.value)} placeholder="cita, fiesta, diario" />
                  </div>
                  <div>
                    <label className={lbl}>Clima (coma)</label>
                    <input className={field} value={f.clima} onChange={(e) => set('clima', e.target.value)} placeholder="invierno, todo el año" />
                  </div>
                  <div>
                    <label className={lbl}>Perfil recomendado</label>
                    <input className={field} value={f.perfil} onChange={(e) => set('perfil', e.target.value)} placeholder="juvenil, elegante…" />
                  </div>
                </>
              )}
              <div className="sm:col-span-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={lbl}>Cuándo recomendarlo</label>
                  <input className={field} value={f.cuandoRecomendar} onChange={(e) => set('cuandoRecomendar', e.target.value)} placeholder="busca duración y presencia" />
                </div>
                <div>
                  <label className={lbl}>Cuándo NO recomendarlo</label>
                  <input className={field} value={f.cuandoNoRecomendar} onChange={(e) => set('cuandoNoRecomendar', e.target.value)} placeholder="quiere algo suave para oficina" />
                </div>
                <div>
                  <label className={lbl}>Objeciones frecuentes (y cómo responder)</label>
                  <input className={field} value={f.objeciones} onChange={(e) => set('objeciones', e.target.value)} placeholder='"es caro" → rinde como uno de lujo' />
                </div>
                <div>
                  <label className={lbl}>Similares / alternativas (coma)</label>
                  <input className={field} value={f.similares} onChange={(e) => set('similares', e.target.value)} placeholder="Odyssey Mega, Asad" />
                </div>
                <div className="sm:col-span-2">
                  <label className={lbl}>Frases de venta sugeridas (separá con ;)</label>
                  <input className={field} value={f.frasesVenta} onChange={(e) => set('frasesVenta', e.target.value)} placeholder="Rendimiento de gama alta a precio accesible; El favorito para regalar" />
                </div>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button type="button" onClick={generarDesdeFicha} className="rounded-lg border border-mint-300 bg-mint-50 px-3 py-1.5 text-xs font-semibold text-mint-700 transition-colors hover:bg-mint-100">
                ✨ Generar “Notas para la IA” desde la ficha
              </button>
              <span className="text-[11px] text-ink-400">Plantilla con TUS datos (sin IA): rellena las notas y, si está vacía, la descripción. Podés editarlas después.</span>
            </div>
          </div>
        </div>

          {error && (
            <p className="mt-4 rounded-lg bg-coral-50 px-3 py-2 text-sm text-coral-700">{error}</p>
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
    </div>
  );
}
