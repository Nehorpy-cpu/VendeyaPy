/**
 * Facturas electrónicas (SET Paraguay y otras autoridades fiscales).
 * Ver ARCHITECTURE.md §10 (Bloque 8).
 */

import type { InvoiceStatus, Currency } from '../enums.js';
import type { Timestamp } from './common.types.js';

export interface InvoiceItem {
  productName: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  taxRate: number;
}

export interface Invoice {
  id: string;
  tenantId: string;
  orderId: string;
  customerId: string;
  number: string | null;
  cdc: string | null; // Código de Control (Paraguay)
  status: InvoiceStatus;
  items: InvoiceItem[];
  subtotal: number;
  taxTotal: number;
  total: number;
  currency: Currency;
  xmlUrl: string | null;
  pdfUrl: string | null;
  submittedAt: Timestamp | null;
  approvedAt: Timestamp | null;
  rejectionReason: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
