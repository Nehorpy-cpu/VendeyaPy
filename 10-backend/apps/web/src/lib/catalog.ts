/**
 * Capa de acceso al catálogo (panel) — productos y categorías en Firestore.
 * El backend (firestore.rules) valida que solo Owner/Manager de la empresa puedan escribir.
 * Todas las funciones reciben tenantId explícito (lo resuelve quien llama: claims o empresa activa).
 */

import {
  collection,
  doc,
  getDocs,
  setDoc,
  deleteDoc,
  query,
  orderBy,
  serverTimestamp,
} from 'firebase/firestore';
import type { Product, Category, ProductFinancials } from '@vpw/shared';
import { firebaseDb } from './firebase';

const productsCol = (tenantId: string) => collection(firebaseDb(), 'tenants', tenantId, 'products');
const categoriesCol = (tenantId: string) =>
  collection(firebaseDb(), 'tenants', tenantId, 'categories');
const productFinancialsCol = (tenantId: string) =>
  collection(firebaseDb(), 'tenants', tenantId, 'productFinancials');

export async function listProducts(tenantId: string): Promise<Product[]> {
  const snap = await getDocs(query(productsCol(tenantId), orderBy('position')));
  return snap.docs.map((d) => d.data() as Product);
}

export async function listCategories(tenantId: string): Promise<Category[]> {
  const snap = await getDocs(query(categoriesCol(tenantId), orderBy('position')));
  return snap.docs.map((d) => d.data() as Category);
}

/** Datos editables de un producto desde el panel (el resto se completa/preserva). */
export interface ProductInput {
  id?: string; // si viene, es edición
  name: string;
  description: string;
  price: number;
  costPrice: number | null;
  priorityScore: number | null;
  aiNotes: string;
  categoryId: string;
  images: string[];
  emoji: string;
  stock: number;
  sku: string;
  status: Product['status'];
  featured: boolean;
  perfume: Product['perfume'];
}

export async function upsertProduct(tenantId: string, input: ProductInput): Promise<string> {
  const id = input.id ?? doc(productsCol(tenantId)).id;
  const ref = doc(productsCol(tenantId), id);
  // El producto visible NO lleva costPrice (lo vería el vendedor). setDoc con merge:
  // crea o actualiza sin pisar createdAt en ediciones.
  await setDoc(
    ref,
    {
      id,
      tenantId,
      name: input.name,
      description: input.description,
      price: input.price,
      compareAtPrice: null,
      aiNotes: input.aiNotes,
      currency: 'PYG',
      categoryId: input.categoryId,
      images: input.images,
      emoji: input.emoji,
      inventory: { trackStock: true, stock: input.stock, lowStockThreshold: 3, sku: input.sku },
      status: input.status,
      featured: input.featured,
      externalIds: { facebook: null, instagram: null, tiktok: null },
      perfume: input.perfume,
      updatedAt: serverTimestamp(),
      ...(input.id ? {} : { createdAt: serverTimestamp(), position: 999 }),
    },
    { merge: true },
  );
  // El costo va en la subcolección privada productFinancials (ADR-0008).
  await setDoc(
    doc(productFinancialsCol(tenantId), id),
    { productId: id, tenantId, costPrice: input.costPrice, priorityScore: input.priorityScore, updatedAt: serverTimestamp() },
    { merge: true },
  );
  return id;
}

export async function deleteProduct(tenantId: string, id: string): Promise<void> {
  await deleteDoc(doc(productsCol(tenantId), id));
  await deleteDoc(doc(productFinancialsCol(tenantId), id));
}

/** Mapa productId → finanzas privadas (costo + prioridad). Solo Owner/Manager (reglas). */
export async function listProductFinancials(tenantId: string): Promise<Record<string, ProductFinancials>> {
  const snap = await getDocs(productFinancialsCol(tenantId));
  const map: Record<string, ProductFinancials> = {};
  snap.docs.forEach((d) => { map[d.id] = d.data() as ProductFinancials; });
  return map;
}

/** Margen de ganancia (null si falta el costo). */
export function productMargin(price: number, costPrice: number | null): number | null {
  if (costPrice == null || price <= 0) return null;
  return ((price - costPrice) / price) * 100;
}
