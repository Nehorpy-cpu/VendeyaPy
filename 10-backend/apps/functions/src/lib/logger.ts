/**
 * Logger estructurado para Cloud Functions.
 * Usa logger nativo de firebase-functions, que se integra con
 * Google Cloud Logging automáticamente.
 */

import { logger as fnLogger } from 'firebase-functions/v2';

export interface LogContext {
  tenantId?: string;
  userId?: string;
  customerId?: string;
  orderId?: string;
  paymentId?: string;
  deliveryId?: string;
  [key: string]: unknown;
}

export const logger = {
  debug: (msg: string, context?: LogContext) => fnLogger.debug(msg, context),
  info: (msg: string, context?: LogContext) => fnLogger.info(msg, context),
  warn: (msg: string, context?: LogContext) => fnLogger.warn(msg, context),
  error: (msg: string, error?: unknown, context?: LogContext) => {
    const errorData =
      error instanceof Error
        ? { message: error.message, stack: error.stack, name: error.name }
        : { error };
    fnLogger.error(msg, { ...context, ...errorData });
  },
};
