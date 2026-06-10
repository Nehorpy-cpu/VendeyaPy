# ARCHITECTURE.md — VentaporWhatsapp

> **Fuente única de verdad del sistema.** Todo diseño, código y decisión técnica debe ser consistente con este documento. Si existe contradicción entre este documento y cualquier otro archivo del proyecto, este documento prevalece.

**Versión:** 1.0.0  
**Fecha:** 2026-05-26  
**Estado:** Activo

---

## Tabla de contenidos

1. [Visión general del SaaS](#1-visión-general-del-saas)
2. [Arquitectura Multi-Tenant](#2-arquitectura-multi-tenant)
3. [Convención de nombres](#3-convención-de-nombres)
4. [Estructura Firestore](#4-estructura-firestore)
5. [Estrategia de autenticación](#5-estrategia-de-autenticación)
6. [Integración WhatsApp Cloud API](#6-integración-whatsapp-cloud-api)
7. [Integración n8n](#7-integración-n8n)
8. [Sistema de pruebas](#8-sistema-de-pruebas)
9. [Estrategia de despliegue](#9-estrategia-de-despliegue)
10. [Roadmap de bloques](#10-roadmap-de-bloques)

---

## 1. Visión general del SaaS

### 1.1 Descripción del producto

**VentaporWhatsapp** es una plataforma SaaS que permite a negocios de Latinoamérica vender productos directamente a través de WhatsApp, sin que el cliente salga de la conversación.

La plataforma provee a cada negocio (tenant):
- Un bot conversacional en WhatsApp con catálogo, carrito y checkout integrados
- Procesamiento de pagos con métodos locales (Bancard, Tigo Money, Personal Pay, Zimple) y globales (Stripe)
- Gestión de entregas con asignación automática de repartidores y tracking GPS
- Panel de administración web en tiempo real
- Facturación electrónica conforme a normativa local (SET Paraguay)
- Integraciones de descubrimiento en redes sociales (Facebook, Instagram, TikTok)

### 1.2 Stack tecnológico

| Capa | Tecnología | Justificación |
|------|-----------|---------------|
| Frontend (Panel Admin) | Next.js 14 (App Router) | SSR + React, deploy en Firebase Hosting |
| Backend (API) | Firebase Cloud Functions (Node.js 20) | Serverless, escala automática, nativo en Firebase |
| Base de datos | Cloud Firestore | NoSQL en tiempo real, nativo Firebase, escala horizontal |
| Autenticación | Firebase Authentication | Nativo Firebase, soporta JWT, roles custom claims |
| Orquestación de flujos | n8n (self-hosted en Cloud Run) | Flujos visuales, webhooks, integraciones sin código |
| WhatsApp | Meta WhatsApp Cloud API | Oficial Meta, gratis hasta 1K conversaciones/mes |
| Storage de archivos | Firebase Storage | Imágenes de productos, facturas PDF, exports |
| Pagos globales | Stripe | Tarjetas internacionales, Apple Pay, Google Pay |
| Pagos Paraguay | Bancard vPOS | Gateway principal de tarjetas en Paraguay |
| Billeteras locales | Tigo Money, Personal Pay, Zimple | Billeteras móviles de Paraguay |
| Mensajería interna | Firebase Pub/Sub | Eventos asincrónicos entre Cloud Functions |
| Monitoreo | Google Cloud Logging + Error Reporting | Nativo en GCP, sin configuración extra |
| CI/CD | GitHub Actions + Firebase CLI | Deploy automático en push a ramas protegidas |

### 1.3 Diagrama de alto nivel

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLIENTES                                │
│   WhatsApp  ←→  Facebook  ←→  Instagram  ←→  TikTok            │
└──────────────────────────┬──────────────────────────────────────┘
                           │ mensajes / webhooks
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                      META WHATSAPP                              │
│              Cloud API (Webhook → Cloud Function)               │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                   FIREBASE / GCP                                │
│                                                                 │
│  ┌──────────────────┐    ┌──────────────────┐                  │
│  │  Cloud Functions │    │    Firestore     │                  │
│  │  (API + Webhooks)│◄──►│  (Multi-tenant)  │                  │
│  └────────┬─────────┘    └──────────────────┘                  │
│           │                                                     │
│  ┌────────▼─────────┐    ┌──────────────────┐                  │
│  │   Pub/Sub        │    │  Firebase Auth   │                  │
│  │  (Eventos async) │    │  (Usuarios)      │                  │
│  └────────┬─────────┘    └──────────────────┘                  │
│           │                                                     │
│  ┌────────▼─────────┐    ┌──────────────────┐                  │
│  │       n8n        │    │  Firebase Storage│                  │
│  │  (Orquestación)  │    │  (Archivos)      │                  │
│  └────────┬─────────┘    └──────────────────┘                  │
└───────────┼─────────────────────────────────────────────────────┘
            │
┌───────────▼─────────────────────────────────────────────────────┐
│                    PASARELAS DE PAGO                            │
│  Stripe  │  Bancard vPOS  │  Tigo Money  │  Personal  │  Zimple │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Arquitectura Multi-Tenant

### 2.1 Modelo de tenancy

El sistema usa **tenancy por documento** en Firestore: cada tenant tiene su propia subcolección raíz bajo `/tenants/{tenantId}`. No se usan bases de datos separadas por tenant.

Esto significa:
- Un único proyecto Firebase sirve a todos los tenants
- El aislamiento de datos se garantiza por reglas de seguridad de Firestore
- El `tenantId` viaja en cada request autenticado via custom claim en el JWT

### 2.2 Jerarquía de entidades

```
Platform (VentaporWhatsapp SaaS)
│
└── Tenant (un negocio cliente)
    │   - Tiene un número WhatsApp Business
    │   - Tiene un plan de suscripción
    │   - Tiene sus propias credenciales de pago
    │
    ├── Store (tienda virtual del tenant)
    │   - Catálogo de productos
    │   - Categorías
    │   - Carrito de clientes
    │
    ├── Customers (clientes del negocio)
    │   - Perfil de cliente
    │   - Historial de pedidos
    │
    ├── Orders (pedidos)
    │   - Líneas de items
    │   - Estado del pago
    │   - Enlace a entrega
    │
    ├── Deliveries (entregas)
    │   - Repartidor asignado
    │   - Estado con timeline
    │   - Eventos GPS
    │
    ├── DeliveryPersons (repartidores)
    │   - Perfil operativo
    │   - Estado de disponibilidad
    │
    └── Config (configuración del tenant)
        - WhatsApp credentials
        - Payment credentials
        - SET/RUC Paraguay
        - Brandings
```

### 2.3 Ciclo de vida de un tenant

```
1. ONBOARDING
   Registro en plataforma → Firebase Auth user creado → 
   tenant document creado → plan FREE asignado → 
   wizard de configuración (WhatsApp, pagos, productos)

2. ACTIVO
   Tenant opera normalmente dentro de su plan.
   Límites aplicados: productos, órdenes/mes, mensajes/mes.

3. UPGRADES
   Tenant cambia de plan → Firestore actualizado → 
   límites ajustados en tiempo real.

4. SUSPENDIDO
   Pago fallido o violación de términos →
   bot desactivado → datos preservados → 
   admin puede reactivar al regularizarse.

5. ELIMINADO
   Soft delete: tenant marcado como deleted → 
   datos preservados 30 días → hard delete automático.
```

### 2.4 Planes del SaaS

| Plan | Productos | Órdenes/mes | Mensajes WA/mes | Repartidores | Precio/mes |
|------|-----------|-------------|-----------------|--------------|------------|
| FREE | 20 | 50 | 500 | 2 | $0 |
| STARTER | 200 | 500 | 5,000 | 10 | $29 |
| GROWTH | 1,000 | 2,000 | 20,000 | 50 | $79 |
| PRO | Ilimitado | Ilimitado | Ilimitado | Ilimitado | $199 |

---

## 3. Convención de nombres

### 3.1 Identificadores únicos

Todo ID en el sistema sigue el patrón `{prefijo}_{nanoid}` donde `nanoid` genera 12 caracteres alfanuméricos.

| Entidad | Prefijo | Ejemplo |
|---------|---------|---------|
| Tenant | `tnt` | `tnt_k3mP9xZ1qR4w` |
| User (admin) | `usr` | `usr_aB7nK2mQ9pLx` |
| Product | `prd` | `prd_vX4tY8jN1mKp` |
| Category | `cat` | `cat_mQ3nB7kL9xZp` |
| Customer | `cst` | `cst_pN2mK9vB4xLq` |
| Order | `ord` | `ord_xZ1kM7pQ4nBv` |
| Order Item | `itm` | `itm_B4nQ9mK1pXvZ` |
| Delivery | `del` | `del_kL7xP3mB9qNv` |
| Delivery Person | `drv` | `drv_mQ4nK8xB2pLv` |
| Payment | `pay` | `pay_vB9nQ1mK4xZp` |
| Invoice | `inv` | `inv_xK3mB7pN9qLv` |
| Subscription | `sub` | `sub_pN1mK6vB3xQz` |
| Webhook Event | `evt` | `evt_mB4nQ9kL1xPv` |

### 3.2 Nombres de colecciones Firestore

- Siempre en **camelCase** en singular: `tenant`, `product`, `order`
- Subcolecciones en **camelCase** en plural: `products`, `orders`, `customers`

### 3.3 Nombres de Cloud Functions

- Patrón: `{dominio}{Accion}` en **camelCase**
- Ejemplos: `whatsappWebhook`, `paymentConfirm`, `deliveryAssign`, `orderCreate`

### 3.4 Variables de entorno

- Siempre en `UPPER_SNAKE_CASE`
- Prefijadas por servicio: `WHATSAPP_TOKEN`, `BANCARD_PRIVATE_KEY`, `STRIPE_SECRET_KEY`
- Variables de Firebase: sin prefijo especial, usan el patrón oficial de Firebase

### 3.5 Nombres de archivos de código

| Tipo | Convención | Ejemplo |
|------|-----------|---------|
| Cloud Function | `camelCase.ts` | `whatsappWebhook.ts` |
| Módulo de negocio | `camelCase.ts` | `orderService.ts` |
| Tipos TypeScript | `camelCase.types.ts` | `order.types.ts` |
| Tests | `camelCase.test.ts` | `orderService.test.ts` |
| Componentes React | `PascalCase.tsx` | `OrderTable.tsx` |
| Páginas Next.js | `kebab-case/page.tsx` | `orders/page.tsx` |
| Constantes | `UPPER_SNAKE_CASE.ts` | `PAYMENT_STATUS.ts` |

### 3.6 Enumeraciones de estado (valores fijos)

**Estado de orden:**
`PENDING_PAYMENT` → `PAID` → `PREPARING` → `ASSIGNED` → `IN_TRANSIT` → `DELIVERED` | `CANCELLED` | `REFUNDED`

**Estado de entrega:**
`PENDING` → `ASSIGNED` → `ACCEPTED` → `IN_TRANSIT` → `ARRIVED` → `DELIVERED` | `FAILED` | `RETURNED`

**Estado de pago:**
`INITIATED` → `PROCESSING` → `APPROVED` | `REJECTED` | `EXPIRED` | `REFUNDED`

**Estado de tenant:**
`ONBOARDING` → `ACTIVE` → `SUSPENDED` | `DELETED`

---

## 4. Estructura Firestore

### 4.1 Diagrama de colecciones

```
/
├── plans/{planId}                    # Planes del SaaS (solo lectura para tenants)
├── tenants/{tenantId}                # Un documento por negocio
│   ├── products/{productId}          # Catálogo de productos del tenant
│   ├── categories/{categoryId}       # Categorías del catálogo
│   ├── customers/{customerId}        # Clientes del negocio (por número WA)
│   │   └── sessions/{sessionId}      # Sesión activa de conversación WA
│   ├── orders/{orderId}              # Pedidos
│   │   └── items/{itemId}            # Líneas del pedido
│   ├── deliveries/{deliveryId}       # Entregas
│   │   └── events/{eventId}          # Timeline de eventos GPS/estado
│   ├── deliveryPersons/{driverId}    # Repartidores registrados
│   ├── payments/{paymentId}          # Registros de transacciones de pago
│   ├── invoices/{invoiceId}          # Facturas electrónicas (SET)
│   ├── subscriptions/{subscriptionId} # Suscripciones recurrentes de clientes
│   └── webhookEvents/{eventId}       # Eventos de webhook recibidos (deduplicación)
└── users/{userId}                    # Usuarios admin de la plataforma
```

### 4.2 Esquema: `tenants/{tenantId}`

```typescript
{
  id: string;                    // "tnt_k3mP9xZ1qR4w"
  name: string;                  // "Tienda Don Pedro"
  slug: string;                  // "tienda-don-pedro" (único, URL-friendly)
  status: "ONBOARDING" | "ACTIVE" | "SUSPENDED" | "DELETED";
  planId: string;                // Ref a /plans/{planId}
  
  contact: {
    ownerName: string;
    email: string;
    phone: string;               // Teléfono del dueño (no WA business)
    country: "PY" | "AR" | "BR" | "MX" | "CO";
  };
  
  whatsapp: {
    phoneNumberId: string;       // ID del número en Meta
    businessAccountId: string;
    accessToken: string;         // Encriptado en reposo
    verifyToken: string;         // Para verificación de webhook
    phoneNumber: string;         // "+595991234567"
  };
  
  payments: {
    bancard: {
      enabled: boolean;
      publicKey: string;
      privateKey: string;        // Encriptado en reposo
      environment: "staging" | "production";
    };
    stripe: {
      enabled: boolean;
      publishableKey: string;
      secretKey: string;         // Encriptado en reposo
      webhookSecret: string;     // Encriptado en reposo
    };
    tigo: {
      enabled: boolean;
      apiKey: string;            // Encriptado en reposo
      merchantId: string;
    };
    personal: {
      enabled: boolean;
      apiKey: string;            // Encriptado en reposo
      merchantId: string;
    };
    zimple: {
      enabled: boolean;
      apiKey: string;            // Encriptado en reposo
      merchantId: string;
    };
  };
  
  fiscal: {
    ruc: string;                 // "80012345"
    dv: string;                  // "7"
    razonSocial: string;
    nombreFantasia: string;
    direccion: string;
    departamento: string;
    ciudad: string;
    telefono: string;
    email: string;
    timbrado: string;
    timbradoFechaInicio: string; // ISO date
    establecimiento: string;     // "001"
    puntoExpedicion: string;     // "001"
    ambiente: "testing" | "production";
    actividadCodigo: string;
    actividadDescripcion: string;
  };
  
  branding: {
    businessName: string;        // Nombre en mensajes WA
    welcomeMessage: string;      // Personalizable
    currency: "PYG" | "ARS" | "USD";
    timezone: string;            // "America/Asuncion"
    locale: "es-PY" | "es-AR" | "es-MX";
  };
  
  limits: {                      // Calculados del plan activo
    maxProducts: number;
    maxOrdersPerMonth: number;
    maxWhatsappMessagesPerMonth: number;
    maxDeliveryPersons: number;
  };
  
  usage: {                       // Contadores del mes actual
    ordersThisMonth: number;
    messagesThisMonth: number;
    currentPeriodStart: Timestamp;
  };
  
  createdAt: Timestamp;
  updatedAt: Timestamp;
  deletedAt: Timestamp | null;
}
```

### 4.3 Esquema: `tenants/{tenantId}/products/{productId}`

```typescript
{
  id: string;                    // "prd_vX4tY8jN1mKp"
  tenantId: string;
  name: string;
  description: string;
  price: number;                 // En la moneda del tenant (sin decimales para PYG)
  compareAtPrice: number | null; // Precio tachado (descuento)
  currency: "PYG" | "ARS" | "USD";
  categoryId: string;            // Ref a categories
  images: string[];              // URLs de Firebase Storage
  emoji: string;                 // "🍕"
  
  inventory: {
    trackStock: boolean;
    stock: number;
    lowStockThreshold: number;   // Alerta cuando stock <= este valor
    sku: string;
  };
  
  status: "ACTIVE" | "INACTIVE" | "ARCHIVED";
  featured: boolean;             // Aparece primero en catálogo
  position: number;              // Orden dentro de su categoría
  
  // Metadatos de catálogos externos
  externalIds: {
    facebook: string | null;
    instagram: string | null;
    tiktok: string | null;
  };
  
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

### 4.4 Esquema: `tenants/{tenantId}/customers/{customerId}`

El `customerId` se deriva del número de WhatsApp del cliente (hash del número).

```typescript
{
  id: string;                    // "cst_pN2mK9vB4xLq"
  tenantId: string;
  whatsappPhone: string;         // "+595991234567" — identificador primario
  name: string;                  // Del perfil WA
  
  address: {
    street: string;
    houseNumber: string;
    city: string;
    neighborhood: string;
    reference: string;           // "Edificio azul junto al banco"
    coordinates: {
      lat: number;
      lng: number;
    } | null;
  } | null;
  
  stats: {
    totalOrders: number;
    totalSpent: number;
    lastOrderAt: Timestamp | null;
    firstOrderAt: Timestamp | null;
  };
  
  tags: string[];                // ["vip", "recurrente", "zona-norte"]
  notes: string;                 // Nota interna del vendedor
  
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

### 4.5 Esquema: `tenants/{tenantId}/customers/{customerId}/sessions/{sessionId}`

Una sesión activa representa la conversación en curso. Solo existe una sesión activa por cliente.

```typescript
{
  id: string;                    // sessionId = "active" (documento único por cliente)
  tenantId: string;
  customerId: string;
  
  state: 
    | "GREETING"
    | "BROWSING"           // Viendo catálogo
    | "VIEWING_PRODUCT"    // Viendo detalle de producto
    | "CART"               // Revisando carrito
    | "SELECTING_PAYMENT"  // Eligiendo método de pago
    | "AWAITING_PAYMENT"   // Link enviado, esperando confirmación
    | "CHECKOUT_DONE"      // Pago confirmado
    | "IDLE";              // Sin actividad
  
  cart: {
    items: Array<{
      productId: string;
      name: string;
      price: number;
      quantity: number;
      imageUrl: string;
    }>;
    subtotal: number;
  };
  
  context: {
    lastMessageAt: Timestamp;
    currentPage: number;         // Paginación del catálogo
    currentCategoryId: string | null;
    pendingOrderId: string | null; // Orden creada, esperando pago
    pendingPaymentId: string | null;
  };
  
  expiresAt: Timestamp;          // +24h de lastMessageAt
  updatedAt: Timestamp;
}
```

### 4.6 Esquema: `tenants/{tenantId}/orders/{orderId}`

```typescript
{
  id: string;                    // "ord_xZ1kM7pQ4nBv"
  tenantId: string;
  customerId: string;
  
  status: 
    | "PENDING_PAYMENT"
    | "PAID"
    | "PREPARING"
    | "ASSIGNED"
    | "IN_TRANSIT"
    | "DELIVERED"
    | "CANCELLED"
    | "REFUNDED";
  
  items: Array<{                 // Snapshot desnormalizado al momento de la compra
    itemId: string;
    productId: string;
    productName: string;
    unitPrice: number;
    quantity: number;
    subtotal: number;
  }>;
  
  totals: {
    subtotal: number;
    discount: number;
    total: number;
    currency: string;
  };
  
  payment: {
    method: "BANCARD" | "STRIPE" | "TIGO" | "PERSONAL" | "ZIMPLE";
    paymentId: string;           // Ref a /payments/{paymentId}
    paidAt: Timestamp | null;
  };
  
  delivery: {
    deliveryId: string | null;   // Ref a /deliveries/{deliveryId}
    address: {
      street: string;
      houseNumber: string;
      city: string;
      neighborhood: string;
      reference: string;
    };
  };
  
  invoice: {
    invoiceId: string | null;    // Ref a /invoices/{invoiceId}
    number: string | null;       // Número de factura SET
  };
  
  channel: "WHATSAPP" | "FACEBOOK" | "INSTAGRAM" | "TIKTOK";
  
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

### 4.7 Esquema: `tenants/{tenantId}/deliveries/{deliveryId}`

```typescript
{
  id: string;                    // "del_kL7xP3mB9qNv"
  tenantId: string;
  orderId: string;
  customerId: string;
  
  status:
    | "PENDING"
    | "ASSIGNED"
    | "ACCEPTED"
    | "IN_TRANSIT"
    | "ARRIVED"
    | "DELIVERED"
    | "FAILED"
    | "RETURNED";
  
  assignedDriverId: string | null;  // Ref a deliveryPersons
  
  destination: {
    street: string;
    houseNumber: string;
    city: string;
    neighborhood: string;
    reference: string;
    coordinates: { lat: number; lng: number } | null;
  };
  
  timeline: Array<{              // Historial de cambios de estado
    status: string;
    timestamp: Timestamp;
    note: string;
    coordinates: { lat: number; lng: number } | null;
  }>;
  
  estimatedDeliveryAt: Timestamp | null;
  deliveredAt: Timestamp | null;
  
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

### 4.8 Esquema: `tenants/{tenantId}/deliveryPersons/{driverId}`

```typescript
{
  id: string;                    // "drv_mQ4nK8xB2pLv"
  tenantId: string;
  name: string;
  whatsappPhone: string;         // Número WA del repartidor
  
  status: "AVAILABLE" | "BUSY" | "OFFLINE";
  isActive: boolean;
  
  area: string;                  // "Centro", "Luque", "San Lorenzo"
  
  currentLocation: {
    coordinates: { lat: number; lng: number };
    updatedAt: Timestamp;
  } | null;
  
  stats: {
    deliveriesToday: number;
    deliveriesTotal: number;
    successRate: number;         // 0-1
    rating: number;              // 1-5
  };
  
  activeDeliveryIds: string[];   // IDs de entregas activas en curso
  
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

### 4.9 Esquema: `users/{userId}`

Usuarios administradores de la plataforma (dueños de tenant y sus colaboradores).

```typescript
{
  id: string;                    // Firebase Auth UID
  email: string;
  name: string;
  
  role: "PLATFORM_ADMIN" | "TENANT_OWNER" | "TENANT_MANAGER" | "TENANT_VIEWER";
  tenantId: string | null;       // null solo para PLATFORM_ADMIN
  
  createdAt: Timestamp;
  lastLoginAt: Timestamp;
}
```

### 4.10 Índices requeridos en Firestore

Los siguientes índices compuestos deben crearse explícitamente:

| Colección | Campos | Dirección | Uso |
|-----------|--------|-----------|-----|
| `tenants/{id}/orders` | `status`, `createdAt` | ASC, DESC | Dashboard órdenes activas |
| `tenants/{id}/orders` | `customerId`, `createdAt` | ASC, DESC | Historial de cliente |
| `tenants/{id}/deliveries` | `status`, `createdAt` | ASC, DESC | Panel de entregas |
| `tenants/{id}/deliveryPersons` | `status`, `area` | ASC, ASC | Búsqueda de repartidor disponible |
| `tenants/{id}/products` | `categoryId`, `status`, `position` | ASC, ASC, ASC | Catálogo paginado |
| `tenants/{id}/customers` | `stats.lastOrderAt` | DESC | CRM por recencia |

---

## 5. Estrategia de autenticación

### 5.1 Roles y permisos

| Rol | Descripción | Acceso |
|-----|-------------|--------|
| `PLATFORM_ADMIN` | Empleado de VentaporWhatsapp | Todos los tenants, panel de plataforma |
| `TENANT_OWNER` | Dueño del negocio | Solo su tenant, acceso completo |
| `TENANT_MANAGER` | Empleado del negocio | Su tenant, sin acceso a credenciales de pago ni configuración |
| `TENANT_VIEWER` | Solo lectura | Su tenant, solo dashboard y órdenes |
| `DELIVERY_PERSON` | Repartidor | Solo su perfil y las entregas asignadas a él (vía API dedicada) |

### 5.2 Flujo de autenticación de usuarios admin

```
1. El usuario accede al panel web (Next.js)
2. Firebase Auth gestiona el login (email/password o Google)
3. Al verificarse, Firebase emite un ID Token JWT
4. El token incluye custom claims: { tenantId, role }
5. El frontend envía el token en cada request: Authorization: Bearer {token}
6. Las Cloud Functions verifican el token con Firebase Admin SDK
7. Las reglas de seguridad de Firestore también verifican el token
```

### 5.3 Custom claims en Firebase Auth

Al crear o actualizar un usuario, la función `userProvision` establece:

```json
{
  "tenantId": "tnt_k3mP9xZ1qR4w",
  "role": "TENANT_OWNER"
}
```

Estos claims se verifican en:
- Reglas de seguridad de Firestore (primera línea de defensa)
- Middleware de Cloud Functions (segunda línea)

### 5.4 Autenticación de webhooks externos

Los webhooks de WhatsApp, Bancard y Stripe llegan sin usuario autenticado. Se verifican por firma criptográfica:

| Fuente | Método de verificación |
|--------|----------------------|
| WhatsApp Cloud API | `X-Hub-Signature-256` header con HMAC-SHA256 |
| Bancard | Hash del cuerpo con private key del tenant |
| Stripe | `Stripe-Signature` header con `stripe.webhooks.constructEvent()` |
| Tigo Money | Token de sesión por transacción |
| Personal Pay | HMAC-SHA256 sobre el body |
| Zimple | API key en header + timestamp |

### 5.5 Acceso de repartidores

Los repartidores interactúan exclusivamente por WhatsApp. No tienen acceso al panel web. La identificación es por número de teléfono: al recibir un mensaje, el sistema verifica si el número existe en `deliveryPersons` de algún tenant.

### 5.6 Reglas de seguridad Firestore (principio base)

```
// Un usuario solo puede leer/escribir datos de su propio tenant
match /tenants/{tenantId}/{document=**} {
  allow read, write: if request.auth.token.tenantId == tenantId
    && request.auth.token.role in ["TENANT_OWNER", "TENANT_MANAGER"];
  allow read: if request.auth.token.tenantId == tenantId
    && request.auth.token.role == "TENANT_VIEWER";
}

// PLATFORM_ADMIN puede acceder a todo
match /{document=**} {
  allow read, write: if request.auth.token.role == "PLATFORM_ADMIN";
}
```

---

## 6. Integración WhatsApp

> **Estrategia de dos etapas (ver ADR-0003).**
> El estado final descrito en esta sección usa **WhatsApp Cloud API oficial**. Sin embargo, la **fase 1 de desarrollo usa OpenWA** (cliente no oficial, ya instalado en `50-whatsapp-server/OpenWA/`) para prototipar el bot sin esperar trámites de Meta. La migración a Cloud API se ejecuta **antes** de conectar Meta Business Suite y correr ads.
>
> **Regla de diseño inviolable:** toda la mensajería va detrás de una abstracción `WhatsAppClient` con adapters intercambiables:
> `WhatsAppClient` (interfaz) → `OpenWAAdapter` (fase 1) → `CloudAPIAdapter` (fase 2).
> El bot y el checkout hablan con la interfaz, nunca con el proveedor directo. Cambiar de adapter no debe tocar la lógica conversacional.

### 6.1 Arquitectura de mensajería (estado final — Cloud API)

```
Usuario en WhatsApp
       │ mensaje
       ▼
Meta WhatsApp Cloud API
       │ POST /webhook
       ▼
Cloud Function: whatsappWebhook
       │ (verifica firma, extrae mensaje)
       │ publica en Pub/Sub topic: wa-message-received
       ▼
n8n Workflow: ConversationRouter
       │ (identifica tenant por número WA)
       │ (determina intención del usuario)
       │ (actualiza sesión en Firestore)
       │ POST a Cloud Function o API interna
       ▼
Cloud Function: whatsappSend
       │ POST a Meta API
       ▼
Usuario en WhatsApp recibe respuesta
```

### 6.2 Registro de webhooks

Cada tenant tiene su propio `VERIFY_TOKEN` único, pero **todos los tenants comparten el mismo endpoint de webhook**:

```
POST https://api.ventaporwhatsapp.com/webhook/whatsapp
```

El sistema determina a qué tenant pertenece un mensaje entrante basándose en el `phoneNumberId` del payload de Meta.

### 6.3 Tipos de mensajes soportados

| Tipo Meta | Uso en el sistema |
|-----------|------------------|
| `text` | Comandos del cliente ("hola", "pagar", números de selección) |
| `interactive/list` | Menú de categorías y opciones de pago |
| `interactive/button` | Confirmaciones (Sí/No, Agregar al carrito) |
| `interactive/flow` | Checkout con formulario de dirección (Flow nativo WA) |
| `image` | Fotos de productos enviadas al cliente |
| `template` | Notificaciones proactivas (confirmación de orden, estado de entrega) |
| `location` | Compartir ubicación por parte del repartidor |

### 6.4 Gestión de conversaciones (estado)

El estado de la conversación se almacena en `sessions/{sessionId}` en Firestore (ver §4.5). n8n lee y actualiza este estado en cada mensaje.

La máquina de estados principal:

```
IDLE / GREETING
    │ "hola" / "menu" / primer mensaje
    ▼
BROWSING ──────────────────────────────────────────────────┐
    │ selecciona categoría o escribe búsqueda               │
    ▼                                                      │
VIEWING_PRODUCT                                            │
    │ "agregar" / "carrito"                                 │
    ▼                                                      │
CART                                                       │
    │ "pagar"                                               │
    ▼                                                      │
SELECTING_PAYMENT                                          │
    │ selecciona método                                     │
    ▼                                                      │
AWAITING_PAYMENT ─────── pago expirado ──────────────────►─┘
    │ webhook de pago confirmado
    ▼
CHECKOUT_DONE ──────────────► IDLE (próximo mensaje)
```

### 6.5 Templates de notificación (HSM)

Los siguientes templates deben ser aprobados por Meta para cada tenant:

| Nombre del template | Trigger | Variables |
|--------------------|---------|-----------|
| `order_confirmed` | Pago aprobado | `{{order_id}}`, `{{total}}`, `{{items_summary}}` |
| `order_in_transit` | Entrega asignada | `{{driver_name}}`, `{{driver_phone}}` |
| `order_arrived` | Estado "ARRIVED" | `{{order_id}}` |
| `order_delivered` | Estado "DELIVERED" | `{{order_id}}` |
| `order_cancelled` | Orden cancelada | `{{order_id}}`, `{{reason}}` |
| `low_stock_alert` | Stock <= threshold | `{{product_name}}`, `{{current_stock}}` |

### 6.6 Límites y cuotas

- La API de Meta permite **1,000 conversaciones gratuitas/mes** por número (ventana 24h)
- Fuera de la ventana de 24h, solo se pueden enviar mensajes con templates aprobados
- El sistema rastrea `usage.messagesThisMonth` por tenant y alerta al 80% del límite del plan
- Los templates tienen tasa de aprobación de Meta de 24-48h, deben registrarse en la fase de onboarding

---

## 7. Integración n8n

### 7.1 Rol de n8n en la arquitectura

n8n actúa como **motor de orquestación de flujos de negocio**. No es el backend de la aplicación (ese rol lo tienen las Cloud Functions), sino el coordinador de secuencias complejas que involucran múltiples servicios, esperas, condiciones y reintento.

**n8n maneja:**
- Flujos de conversación WhatsApp (máquina de estados del chat)
- Procesamiento de webhooks de pago (confirmación y fallo)
- Asignación automática de repartidores
- Notificaciones proactivas (estado de entrega)
- Automatización de marketing (carrito abandonado, re-engagement)
- Generación y envío de reportes periódicos

**n8n NO maneja:**
- Autenticación de usuarios (Firebase Auth)
- Persistencia de datos (Cloud Functions + Firestore)
- Verificación de firmas de webhooks (Cloud Functions)
- Lógica de negocio crítica con transacciones (Cloud Functions)

### 7.2 Infraestructura de n8n

n8n se despliega en **Cloud Run** como contenedor stateless, con datos de workflows en **Cloud SQL (PostgreSQL)**.

```
n8n Container (Cloud Run)
├── CPU: 1 vCPU mínimo, 2 recomendado
├── RAM: 512MB mínimo, 1GB recomendado
├── Autoscaling: 1-5 instancias
└── Data: Cloud SQL PostgreSQL (persistencia de workflows y ejecuciones)

n8n Webhook URL (pública):
https://n8n.ventaporwhatsapp.com/webhook/{workflowId}
```

### 7.3 Workflows principales

#### WF-001: ConversationRouter
**Trigger:** Webhook desde Pub/Sub (mensaje WA recibido)  
**Propósito:** Enrutar el mensaje al flujo correcto según el estado de sesión  
**Pasos:**
1. Recibir payload del mensaje
2. Leer sesión actual de Firestore (HTTP Request a Cloud Function)
3. Evaluar estado (`Switch` node)
4. Llamar al sub-workflow correspondiente
5. Actualizar estado de sesión

#### WF-002: CatalogFlow
**Trigger:** Llamado por WF-001 cuando `state = BROWSING`  
**Propósito:** Mostrar catálogo paginado por categorías  
**Pasos:**
1. Leer categorías del tenant desde Firestore
2. Construir mensaje interactivo (lista)
3. Enviar por WA Cloud API
4. Si selecciona categoría: cargar productos paginados
5. Si busca texto: ejecutar búsqueda en Firestore

#### WF-003: CartFlow
**Trigger:** Llamado por WF-001 cuando `state = CART` o "agregar"  
**Propósito:** Gestionar el carrito de compras  
**Pasos:**
1. Agregar/eliminar item del carrito en sesión Firestore
2. Recalcular totales
3. Enviar resumen del carrito al cliente
4. Si "pagar": transicionar a WF-004

#### WF-004: CheckoutFlow
**Trigger:** Cliente dice "pagar"  
**Propósito:** Guiar al cliente por el proceso de pago  
**Pasos:**
1. Verificar stock disponible
2. Crear pre-orden en Firestore (estado `PENDING_PAYMENT`)
3. Presentar métodos de pago disponibles para el tenant
4. Según método: generar link de pago (Bancard/Stripe/billetera)
5. Enviar link por WA
6. Actualizar sesión a `AWAITING_PAYMENT`

#### WF-005: PaymentConfirmedFlow
**Trigger:** Webhook de pago aprobado (Bancard/Stripe/billetera)  
**Propósito:** Procesar pago exitoso  
**Pasos:**
1. Actualizar orden a `PAID`
2. Descontar inventario
3. Emitir factura electrónica SET (si tenant tiene fiscal habilitado)
4. Disparar WF-006 (asignación de entrega)
5. Notificar al cliente (template `order_confirmed`)
6. Actualizar métricas del tenant

#### WF-006: DeliveryAssignFlow
**Trigger:** Llamado por WF-005 al confirmar pago  
**Propósito:** Asignar automáticamente un repartidor  
**Pasos:**
1. Leer repartidores disponibles del tenant (estado `AVAILABLE`)
2. Filtrar por área geográfica si configurado
3. Seleccionar el menos cargado (menor `deliveriesToday`)
4. Crear documento de entrega en Firestore
5. Enviar mensaje WA al repartidor con detalles + link Google Maps
6. Esperar respuesta (max 5 minutos con timer)
7. Si "ACEPTO": marcar entrega como `ACCEPTED`
8. Si timeout o "RECHAZO": intentar con el siguiente repartidor disponible
9. Si no hay repartidores: notificar al admin del tenant

#### WF-007: DeliveryStatusFlow
**Trigger:** Mensaje de repartidor que contiene keywords de estado  
**Propósito:** Actualizar estado de entrega y notificar al cliente  
**Keywords:** "en camino", "llegué", "entregado", "fallo", "ACEPTO {id}", "RECHAZO {id}"  
**Pasos:**
1. Identificar repartidor por número WA
2. Identificar entrega activa del repartidor
3. Actualizar estado en Firestore + agregar evento al timeline
4. Enviar template WA correspondiente al cliente

#### WF-008: AbandonedCartFlow
**Trigger:** Cron cada 30 minutos  
**Propósito:** Recuperar carritos abandonados  
**Pasos:**
1. Buscar sesiones con `state = AWAITING_PAYMENT` o `CART` y `lastMessageAt > 2h`
2. Para cada sesión: enviar recordatorio WA
3. Si carrito lleva >24h: limpiar sesión y marcar orden como `CANCELLED`

#### WF-009: ReportFlow
**Trigger:** Cron diario a las 8:00 (timezone del tenant)  
**Propósito:** Enviar reporte diario al admin del tenant  
**Pasos:**
1. Calcular métricas del día anterior
2. Generar resumen en texto
3. Enviar por WA al número admin del tenant

### 7.4 Comunicación Cloud Functions ↔ n8n

```
Cloud Function → n8n:
  HTTP POST a https://n8n.ventaporwhatsapp.com/webhook/{workflowId}
  con payload del evento + tenantId + firma HMAC

n8n → Cloud Function:
  HTTP POST a https://api.ventaporwhatsapp.com/internal/{action}
  con header: X-Internal-Secret: {secretToken}
  (nunca expuesto públicamente)
```

---

## 8. Sistema de pruebas

### 8.1 Pirámide de pruebas

```
        ┌─────────────────────┐
        │    E2E Tests        │  5% — Flujos críticos completos
        │  (n8n + WA mock)   │
        ├─────────────────────┤
        │  Integration Tests  │  25% — Cloud Functions con Firestore emulado
        │  (Firebase Emulator)│
        ├─────────────────────┤
        │    Unit Tests       │  70% — Lógica de negocio pura
        │    (Vitest)         │
        └─────────────────────┘
```

### 8.2 Herramientas

| Capa | Herramienta | Uso |
|------|------------|-----|
| Unit | Vitest | Funciones de negocio puras (cálculo de totales, validaciones, mapeo de datos) |
| Integration | Firebase Emulator Suite + Vitest | Cloud Functions contra Firestore/Auth local |
| E2E | Playwright + WhatsApp Business API sandbox | Flujos completos de compra |
| Mocks | Vitest mocks + MSW | APIs externas (Meta, Bancard, Stripe) |
| Coverage | Vitest Coverage (Istanbul) | Mínimo 80% en módulos de negocio |

### 8.3 Entorno de pruebas de pasarelas de pago

| Pasarela | Entorno de test | Tarjetas/datos de prueba |
|----------|----------------|--------------------------|
| Stripe | `sk_test_*` keys | `4242 4242 4242 4242` (aprobada) |
| Bancard | `staging` endpoint | Números de prueba provistos por Bancard |
| Tigo Money | Sandbox Tigo | Número de prueba `+595999000001` |
| Personal Pay | Staging Personal | Credenciales de sandbox |
| Zimple | Test environment | API key de prueba |

### 8.4 Estrategia de fixtures

Los fixtures de Firestore para pruebas se definen en `tests/fixtures/` y se cargan contra el emulador antes de cada suite. Un fixture completo de tenant incluye:
- 1 tenant activo con todas las configuraciones
- 10 productos en 3 categorías
- 5 customers con historial
- 3 delivery persons disponibles
- 5 órdenes en distintos estados

### 8.5 Pruebas de WhatsApp

Para E2E sin necesitar un número real de WA:
- Se usa la **WhatsApp Cloud API Sandbox** de Meta (disponible en Meta Developers)
- Para CI/CD: se usa un mock del webhook con payloads predefinidos
- Los payloads de ejemplo se almacenan en `tests/whatsapp-payloads/`

### 8.6 Cobertura mínima requerida por módulo

| Módulo | Cobertura mínima |
|--------|-----------------|
| `orderService` | 90% |
| `inventoryService` | 90% |
| `paymentService` | 85% |
| `deliveryService` | 85% |
| `conversationRouter` | 80% |
| `invoiceService` (SET) | 80% |
| Panel admin (componentes React) | 60% |

---

## 9. Estrategia de despliegue

### 9.1 Entornos

| Entorno | Propósito | Firebase Project | URL |
|---------|-----------|-----------------|-----|
| `dev` | Desarrollo local | `vpw-dev` | `localhost` |
| `staging` | QA y demos | `vpw-staging` | `staging.ventaporwhatsapp.com` |
| `production` | Producción | `vpw-prod` | `ventaporwhatsapp.com` |

### 9.2 Estructura del repositorio

```
ventaporwhatsapp/
├── apps/
│   ├── web/                          # Panel admin (Next.js)
│   └── functions/                    # Cloud Functions (Node.js)
├── packages/
│   ├── shared/                       # Tipos TypeScript compartidos
│   ├── firebase-config/              # Configuración Firebase (reglas, índices)
│   └── n8n-workflows/                # Exportaciones JSON de workflows n8n
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── e2e/
│   └── fixtures/
├── .github/
│   └── workflows/
│       ├── ci.yml                    # Tests en cada PR
│       └── deploy.yml                # Deploy automático
├── firebase.json
├── firestore.rules
├── firestore.indexes.json
└── ARCHITECTURE.md                   # Este documento
```

Estructura de monorepo gestionada con **pnpm workspaces**.

### 9.3 Pipeline CI/CD

```
PR abierto
    │
    ▼
GitHub Actions: ci.yml
    ├── pnpm install
    ├── TypeScript typecheck
    ├── ESLint
    ├── Vitest (unit + integration con Firebase Emulator)
    └── Build check
    
    Si pasa ──► Review disponible para merge
    Si falla ──► PR bloqueado
    
Merge a `main`
    │
    ▼
GitHub Actions: deploy.yml (staging)
    ├── Deploy Cloud Functions a vpw-staging
    ├── Deploy Next.js a Firebase Hosting (staging)
    ├── Deploy reglas Firestore a vpw-staging
    └── Deploy n8n workflows (vía API de n8n)

Tag de release (v*.*.*) en `main`
    │
    ▼
GitHub Actions: deploy.yml (production)
    ├── [Manual approval required]
    ├── Deploy Cloud Functions a vpw-prod
    ├── Deploy Next.js a Firebase Hosting (prod)
    ├── Deploy reglas Firestore a vpw-prod
    └── Deploy n8n workflows
```

### 9.4 Variables de entorno por entorno

Las variables de entorno se gestionan con:
- **Local (`dev`):** Archivo `.env.local` (nunca commiteado)
- **Staging/Prod:** Google Cloud Secret Manager + Firebase Functions config

Variables críticas que NUNCA van al repositorio:
- `WHATSAPP_ACCESS_TOKEN` (por tenant, guardado en Firestore cifrado)
- `BANCARD_PRIVATE_KEY` (por tenant, guardado en Firestore cifrado)
- `STRIPE_SECRET_KEY` (por tenant, guardado en Firestore cifrado)
- `N8N_INTERNAL_SECRET` (secreto de comunicación interna)
- `FIREBASE_SERVICE_ACCOUNT` (solo para CI/CD en GitHub Secrets)

### 9.5 Escalabilidad

**Cloud Functions:** Escalan automáticamente. Configurar `minInstances: 1` para las funciones de webhook para evitar cold starts en producción.

**Firestore:** Escala automáticamente hasta millones de documentos. El diseño de colecciones por tenant garantiza que lecturas/escrituras de un tenant no afectan a otros.

**n8n (Cloud Run):** Configurar `maxInstances: 5` para comenzar. Escalar según carga observada.

**Límites a monitorear:**
- Lecturas Firestore: ~50K gratis/día por proyecto (plan Spark), ilimitado en Blaze
- Llamadas Cloud Functions: 2M gratis/mes, luego facturado
- WhatsApp Cloud API: 1K conversaciones gratis/mes por número de negocio

---

## 10. Roadmap de bloques

Los bloques son unidades de trabajo secuenciales. Cada bloque debe estar completado y en staging antes de iniciar el siguiente.

### Bloque 0: Fundación (Semana 1-2)
**Objetivo:** Infraestructura base lista para desarrollo

- [ ] Crear proyectos Firebase (dev, staging, prod)
- [ ] Configurar monorepo con pnpm workspaces
- [ ] Definir tipos TypeScript compartidos (`packages/shared`)
- [ ] Implementar reglas de seguridad Firestore base
- [ ] Configurar índices Firestore
- [ ] Configurar GitHub Actions (CI básico)
- [ ] Desplegar n8n en Cloud Run (dev y staging)
- [ ] Crear scripts de seed de datos de prueba

**Criterio de salida:** CI verde, Firebase Emulator funcionando, n8n accesible.

---

### Bloque 1: Tenant y Autenticación (Semana 2-3)
**Objetivo:** Un negocio puede registrarse y configurar su cuenta

- [ ] Firebase Auth configurado con custom claims
- [ ] Cloud Function: `tenantCreate` (onboarding wizard)
- [ ] Cloud Function: `tenantGet` / `tenantUpdate`
- [ ] Cloud Function: `userProvision` (asigna custom claims)
- [ ] Panel Admin: página de login (Firebase Auth UI)
- [ ] Panel Admin: wizard de onboarding (datos del negocio, WA config)
- [ ] Panel Admin: dashboard vacío con sidebar de navegación

**Criterio de salida:** Un tenant puede registrarse, configurar su número de WhatsApp y ver su panel vacío.

---

### Bloque 2: Catálogo de Productos (Semana 3-4)
**Objetivo:** El tenant puede gestionar su catálogo

- [ ] Cloud Function: CRUD de productos
- [ ] Cloud Function: CRUD de categorías
- [ ] Cloud Function: gestión de inventario (ajuste manual de stock)
- [ ] Firebase Storage: upload de imágenes de productos
- [ ] Panel Admin: página de productos (lista, crear, editar, archivar)
- [ ] Panel Admin: página de categorías
- [ ] Panel Admin: alertas de stock bajo

**Criterio de salida:** El tenant tiene 10+ productos cargados, con imágenes, precios y stock.

---

### Bloque 3: Bot de WhatsApp — Catálogo y Carrito (Semana 4-6)
**Objetivo:** Un cliente puede explorar el catálogo y armar su carrito por WhatsApp

- [ ] Cloud Function: `whatsappWebhook` (verificación de firma + Pub/Sub)
- [ ] Cloud Function: `whatsappSend` (envío de mensajes via Meta API)
- [ ] Cloud Function: sesión management (leer/escribir en Firestore)
- [ ] n8n Workflow WF-001: ConversationRouter
- [ ] n8n Workflow WF-002: CatalogFlow (categorías, búsqueda, paginación)
- [ ] n8n Workflow WF-003: CartFlow (agregar, eliminar, ver carrito)
- [ ] Registro del webhook en Meta Business Platform (por tenant)
- [ ] Tests: payloads de WhatsApp simulados

**Criterio de salida:** Un tester puede enviar mensajes por WhatsApp, navegar el catálogo y armar un carrito.

---

### Bloque 4: Pagos — Bancard y Stripe (Semana 6-8)
**Objetivo:** El cliente puede pagar sin salir de WhatsApp

- [ ] Cloud Function: `paymentBancardCreate` (generar link de pago)
- [ ] Cloud Function: `paymentBancardWebhook` (verificar y confirmar)
- [ ] Cloud Function: `paymentStripeCreate` (generar Checkout Session)
- [ ] Cloud Function: `paymentStripeWebhook`
- [ ] Cloud Function: `orderCreate` (al confirmar pago)
- [ ] Descuento de inventario al confirmar pago
- [ ] n8n Workflow WF-004: CheckoutFlow
- [ ] n8n Workflow WF-005: PaymentConfirmedFlow
- [ ] Tests: webhooks de pago simulados con tarjetas de prueba

**Criterio de salida:** Un tester puede completar una compra de punta a punta con Bancard sandbox y Stripe test.

---

### Bloque 5: Entregas y Repartidores (Semana 8-10)
**Objetivo:** Las órdenes se asignan y rastrean automáticamente

- [ ] Cloud Function: CRUD de repartidores
- [ ] Cloud Function: `deliveryCreate` (al confirmar pago)
- [ ] n8n Workflow WF-006: DeliveryAssignFlow
- [ ] n8n Workflow WF-007: DeliveryStatusFlow (keywords por WA)
- [ ] Panel Admin: página de entregas (lista, mapa, timeline)
- [ ] Panel Admin: página de repartidores (estado en vivo, asignación manual)
- [ ] Templates WA aprobados: `order_in_transit`, `order_delivered`, etc.

**Criterio de salida:** Al confirmar un pago, se asigna automáticamente un repartidor y el cliente recibe actualizaciones por WhatsApp.

---

### Bloque 6: Panel Admin — Dashboard Completo (Semana 10-11)
**Objetivo:** El tenant tiene visibilidad total de su negocio

- [ ] Panel Admin: KPIs en tiempo real (ventas, órdenes, entregas)
- [ ] Panel Admin: lista de órdenes con filtros y búsqueda
- [ ] Panel Admin: detalle de orden con timeline
- [ ] Panel Admin: gestión de clientes (CRM básico)
- [ ] Panel Admin: reportes de ventas por período (gráficos)
- [ ] Panel Admin: configuración del tenant (credenciales de pago, branding)
- [ ] n8n Workflow WF-009: ReportFlow (reporte diario por WA)

**Criterio de salida:** El tenant puede ver métricas del día, gestionar órdenes y recibe reporte diario automático.

---

### Bloque 7: Billeteras Locales Paraguay (Semana 11-12)
**Objetivo:** Soporte para Tigo Money, Personal Pay y Zimple

- [ ] Cloud Function: `paymentTigoCreate` / `paymentTigoWebhook`
- [ ] Cloud Function: `paymentPersonalCreate` / `paymentPersonalWebhook`
- [ ] Cloud Function: `paymentZimpleCreate` / `paymentZimpleWebhook`
- [ ] Actualizar WF-004 (CheckoutFlow) para incluir las 3 billeteras
- [ ] Panel Admin: configuración de billeteras por tenant
- [ ] Tests con sandboxes de cada billetera

**Criterio de salida:** Cliente puede pagar con Tigo Money, Personal Pay o Zimple.

---

### Bloque 8: Facturación Electrónica SET (Semana 12-13)
**Objetivo:** Generación automática de facturas electrónicas para Paraguay

- [ ] Cloud Function: `invoiceCreate` (genera XML formato SET)
- [ ] Cloud Function: `invoiceSubmit` (envío a API SIFEN del SET)
- [ ] Cloud Function: `invoiceGet` (consulta estado en SET)
- [ ] Actualizar WF-005 para disparar facturación automática al pagar
- [ ] Panel Admin: módulo de facturas (lista, descarga PDF, estado)
- [ ] Panel Admin: configuración fiscal del tenant (RUC, timbrado, etc.)

**Criterio de salida:** Cada pago genera automáticamente una factura electrónica válida ante el SET Paraguay.

---

### Bloque 9: SaaS — Suscripciones y Onboarding de Plataforma (Semana 13-15)
**Objetivo:** La plataforma puede adquirir y cobrar a sus propios clientes (tenants)

- [ ] Stripe Billing configurado para cobro de planes del SaaS
- [ ] Cloud Function: `subscriptionCreate` / `subscriptionWebhook`
- [ ] Aplicación de límites de plan en tiempo real
- [ ] Panel Admin: página de suscripción y facturación del tenant
- [ ] Landing page pública (Next.js) para adquisición de nuevos tenants
- [ ] Wizard de onboarding guiado (registro → configuración WA → primer producto)
- [ ] Panel de PLATFORM_ADMIN (gestión de todos los tenants)

**Criterio de salida:** Un nuevo negocio puede registrarse sin intervención manual, configurar su cuenta y quedar operativo.

---

### Bloque 10: Características Avanzadas (Semana 15-18)
**Objetivo:** Funcionalidades que aumentan retención y LTV de los tenants

- [ ] Suscripciones recurrentes de clientes finales (Stripe Recurring)
- [ ] Pagos en cuotas (integración con cuotas Bancard)
- [ ] Omnichannel: sincronización de catálogo con Facebook/Instagram
- [ ] Marketing automation: n8n WF-008 (carrito abandonado)
- [ ] CRM avanzado: segmentación RFM, campañas por WA
- [ ] Apple Pay / Google Pay via Stripe (Stripe Payment Request Button)
- [ ] Reportes financieros: conciliación bancaria, exportación Excel/CSV

**Criterio de salida:** Los tenants reportan incremento de conversión. Flujos de recuperación de carrito operativos.

---

## Apéndice A: Decisiones arquitectónicas registradas

| ID | Decisión | Alternativa descartada | Razón |
|----|---------|----------------------|-------|
| ADR-001 | Firebase Cloud Functions como backend | Node.js en VM | Menos ops overhead, escala automática, nativo Firebase |
| ADR-002 | Firestore multi-tenant por documento | Base de datos separada por tenant | Costo y complejidad operacional menor; aislamiento garantizado por security rules |
| ADR-003 | n8n para orquestación de flujos | Lógica de estado en Cloud Functions | Flujos conversacionales son más mantenibles visualmente; facilita cambios sin deploy |
| ADR-004 | IDs propios con prefijo (`ord_...`) | Firebase auto-IDs | Legibilidad en logs, soporte, comunicación con clientes |
| ADR-005 | Sesión de conversación en Firestore | Redis / memoria n8n | Persistencia garantizada, visible desde el panel admin, sin estado en servidores |
| ADR-006 | Un único webhook endpoint para todos los tenants | Webhook por tenant | Simplifica la gestión de certificados SSL y configuración de Meta; el routing por `phoneNumberId` es suficiente |

---

*Última actualización: 2026-05-26 — Versión inicial.*
