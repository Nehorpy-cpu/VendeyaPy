/**
 * Generación y validación de IDs con prefijo.
 * Patrón: `{prefijo}_{nanoid12}` — ver ARCHITECTURE.md §3.1.
 */

import { customAlphabet } from 'nanoid';

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ID_LENGTH = 12;

const generateId = customAlphabet(ID_ALPHABET, ID_LENGTH);

export const ID_PREFIX = {
  TENANT: 'tnt',
  USER: 'usr',
  PRODUCT: 'prd',
  CATEGORY: 'cat',
  CUSTOMER: 'cst',
  ORDER: 'ord',
  ORDER_ITEM: 'itm',
  DELIVERY: 'del',
  DELIVERY_PERSON: 'drv',
  PAYMENT: 'pay',
  INVOICE: 'inv',
  SUBSCRIPTION: 'sub',
  WEBHOOK_EVENT: 'evt',
  PLAN: 'pln',
  COVERAGE_REQUEST: 'covr',
} as const;

export type IdPrefix = (typeof ID_PREFIX)[keyof typeof ID_PREFIX];

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${generateId()}`;
}

export function isValidId(id: string, prefix: IdPrefix): boolean {
  const pattern = new RegExp(`^${prefix}_[${ID_ALPHABET}]{${ID_LENGTH}}$`);
  return pattern.test(id);
}

export function getPrefix(id: string): string | null {
  const parts = id.split('_');
  return parts.length === 2 && parts[0] ? parts[0] : null;
}

// Helpers tipados
export const newTenantId = () => newId(ID_PREFIX.TENANT);
export const newUserId = () => newId(ID_PREFIX.USER);
export const newProductId = () => newId(ID_PREFIX.PRODUCT);
export const newCategoryId = () => newId(ID_PREFIX.CATEGORY);
export const newCustomerId = () => newId(ID_PREFIX.CUSTOMER);
export const newOrderId = () => newId(ID_PREFIX.ORDER);
export const newOrderItemId = () => newId(ID_PREFIX.ORDER_ITEM);
export const newDeliveryId = () => newId(ID_PREFIX.DELIVERY);
export const newDeliveryPersonId = () => newId(ID_PREFIX.DELIVERY_PERSON);
export const newPaymentId = () => newId(ID_PREFIX.PAYMENT);
export const newInvoiceId = () => newId(ID_PREFIX.INVOICE);
export const newSubscriptionId = () => newId(ID_PREFIX.SUBSCRIPTION);
export const newWebhookEventId = () => newId(ID_PREFIX.WEBHOOK_EVENT);
export const newCoverageRequestId = () => newId(ID_PREFIX.COVERAGE_REQUEST);
