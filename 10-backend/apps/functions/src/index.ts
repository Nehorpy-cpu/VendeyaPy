/**
 * Punto de entrada de Cloud Functions de VentaporWhatsapp.
 *
 * Cada función exportada se despliega como una function independiente.
 * El naming sigue {dominio}{Accion} en camelCase — ver ARCHITECTURE.md §3.3.
 *
 * Las funciones se agrupan por dominio en src/functions/ y se re-exportan
 * desde acá para que firebase-functions las detecte.
 */

import { initializeApp } from 'firebase-admin/app';

// Inicializar Firebase Admin una sola vez por instancia
initializeApp();

// ===== Webhooks externos =====
// export { whatsappWebhook } from './functions/whatsapp/whatsappWebhook.js';
// export { paymentBancardWebhook } from './functions/payments/paymentBancardWebhook.js';
// export { paymentStripeWebhook } from './functions/payments/paymentStripeWebhook.js';

// ===== API HTTP (panel admin) =====
// export { tenantCreate } from './functions/tenants/tenantCreate.js';
// export { tenantUpdate } from './functions/tenants/tenantUpdate.js';
// export { userProvision } from './functions/users/userProvision.js';
// export { productCreate } from './functions/products/productCreate.js';

// ===== Triggers (Firestore / Pub/Sub) =====
// export { onOrderCreated } from './functions/orders/onOrderCreated.js';
// export { onPaymentApproved } from './functions/payments/onPaymentApproved.js';

// ===== Endpoints internos (n8n → Functions) =====
// export { internalAssignDelivery } from './functions/internal/internalAssignDelivery.js';
// export { internalSendWhatsapp } from './functions/internal/internalSendWhatsapp.js';

// Health check (export estático — el emulador de Functions no soporta top-level await)
export { healthCheck } from './functions/healthCheck.js';

// Bot conversacional — endpoint de prueba (F4). El webhook real de WhatsApp (F1) usará el mismo motor.
export { devMessage } from './functions/conversation/devMessage.js';
