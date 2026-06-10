/**
 * Productos y categorías del catálogo del tenant.
 * Ver ARCHITECTURE.md §4.3.
 */

import type { ProductStatus, Currency } from '../enums.js';
import type { Timestamp } from './common.types.js';

export interface ProductInventory {
  trackStock: boolean;
  stock: number;
  lowStockThreshold: number;
  sku: string;
}

export interface ProductExternalIds {
  facebook: string | null;
  instagram: string | null;
  tiktok: string | null;
}

export interface Product {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  price: number;
  compareAtPrice: number | null;
  currency: Currency;
  categoryId: string;
  images: string[];
  emoji: string;
  inventory: ProductInventory;
  status: ProductStatus;
  featured: boolean;
  position: number;
  externalIds: ProductExternalIds;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Category {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  emoji: string;
  position: number;
  isActive: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
