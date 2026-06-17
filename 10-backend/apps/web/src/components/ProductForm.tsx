'use client';

import { useState } from 'react';
import type { Product, Category } from '@vpw/shared';
import type { ProductInput } from '@/lib/catalog';

const GENDERS = ['Femenino', 'Masculino', 'Unisex'] as const;
const STATUSES: Product['status'][] = ['ACTIVE', 'INACTIVE', 'ARCHIVED'];

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
}

export function ProductForm({ initial, initialCost, initialPriority, categories, onCancel, onSubmit, saving }: Props) {
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
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
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
      perfume: {
        brand: f.brand.trim(),
        gender: f.gender,
        olfactiveFamily: f.olfactiveFamily.trim(),
        styleTags: csv(f.styleTags),
        notes: { top: csv(f.notesTop), heart: csv(f.notesHeart), base: csv(f.notesBase) },
        priceRange: priceRangeFromPrice(Number(f.price) || 0),
        sizeMl: f.sizeMl ? Number(f.sizeMl) : null,
        isNew: f.isNew,
      },
    };
    onSubmit(input);
  };

  const field = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none';
  const lbl = 'mb-1 block text-xs font-medium text-gray-600';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
      <form onSubmit={submit} className="my-8 w-full max-w-2xl rounded-2xl bg-white p-6 shadow-xl">
        <h2 className="mb-4 text-lg font-bold text-gray-900">
          {initial ? 'Editar producto' : 'Nuevo producto'}
        </h2>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={lbl}>Nombre *</label>
            <input className={field} required value={f.name} onChange={(e) => set('name', e.target.value)} />
          </div>
          <div>
            <label className={lbl}>Marca</label>
            <input className={field} value={f.brand} onChange={(e) => set('brand', e.target.value)} />
          </div>
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
          <div>
            <label className={lbl}>Tamaño (ml)</label>
            <input className={field} type="number" value={f.sizeMl} onChange={(e) => set('sizeMl', Number(e.target.value))} />
          </div>
          <div>
            <label className={lbl}>Categoría</label>
            <select className={field} value={f.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
              {categories.length === 0 && <option value="perfumes">perfumes</option>}
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
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
          <div>
            <label className={lbl}>Estado</label>
            <select className={field} value={f.status} onChange={(e) => set('status', e.target.value as Product['status'])}>
              {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
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
            <textarea className={field} rows={2} value={f.aiNotes} onChange={(e) => set('aiNotes', e.target.value)} placeholder="Beneficios, público ideal, cuándo recomendarlo…" />
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={f.featured} onChange={(e) => set('featured', e.target.checked)} /> Destacado
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={f.isNew} onChange={(e) => set('isNew', e.target.checked)} /> Nuevo
          </label>
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button type="button" onClick={onCancel} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100">
            Cancelar
          </button>
          <button type="submit" disabled={saving} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">
            {saving ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </form>
    </div>
  );
}
