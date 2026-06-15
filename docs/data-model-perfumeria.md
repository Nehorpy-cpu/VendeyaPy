# Modelo de datos — Tenant Perfumería (Fase 1)

> Diseño de datos para el tenant `perfumeria`. Parte del esquema multi-tenant
> heredado de VentaporWhatsapp (ver `00-architecture/ARCHITECTURE.md §4`).
> **Última actualización:** 2026-06-15

---

## 1. Qué ya existe (heredado, sin cambios)

La estructura multi-tenant en Firestore ya está diseñada y cubierta por reglas e índices:

```
tenants/{tenantId}                         ← documento del negocio (config, branding, pagos PY, fiscal SET)
  ├── products/{productId}                 ← catálogo
  ├── categories/{categoryId}              ← categorías
  ├── customers/{customerId}               ← clientes (compradores por WhatsApp)
  │     └── sessions/{sessionId}           ← estado de conversación del bot
  ├── orders/{orderId}                     ← pedidos
  │     └── items/{itemId}
  ├── payments/{paymentId}                 ← pagos
  ├── invoices/{invoiceId}                 ← facturas (SET Paraguay)
  └── deliveries / deliveryPersons         ← logística (no se usa en fase 1)
```

- **Aislamiento:** reglas de Firestore validan `tenantId` + `role` (custom claims). Default-deny.
- **Escritura sensible** (sesiones, órdenes, pagos): solo Cloud Functions (Admin SDK).
- En fase 1 (perfumería) usamos: `products`, `categories`, `customers`, `sessions`, `orders`, `payments`, `invoices`. No usamos `deliveries`/`deliveryPersons` todavía.

**Decisión:** `tenantId = "perfumeria"` para el primer (y por ahora único) tenant.

---

## 2. El hueco: atributos de perfume

El tipo `Product` heredado es genérico. Para que el bot recomiende bien (filtrar por
género, estilo, presupuesto — como hace el RAG de Arfagi) hay que sumar atributos
específicos de perfumería.

### Decisión de diseño

Agregar un sub-objeto **opcional** `perfume` al tipo `Product`, en vez de ensuciar el
tipo base o usar un mapa sin tipar. Ventajas: tipado fuerte, no rompe otros verticales,
y la herramienta de catálogo puede indexar `perfume.gender`, `perfume.priceRange`, etc.

```ts
export interface PerfumeAttributes {
  brand: string;                                  // marca (ej: "Carolina Herrera")
  gender: 'Femenino' | 'Masculino' | 'Unisex';    // género
  olfactiveFamily: string;                         // familia olfativa (floral, oriental, amaderado...)
  styleTags: string[];                             // estilos para búsqueda: dulce, fresco, intenso, árabe, cítrico...
  priceRange: 'ACCESIBLE' | 'MID' | 'PREMIUM' | 'LUJO';  // espeja RANGOS de Arfagi
  sizeMl: number | null;                           // tamaño en ml
  isNew: boolean;                                  // recién llegado
}

// En Product:
//   perfume: PerfumeAttributes | null;   // null para productos no-perfume (cremas, etc.)
```

Rangos de precio (Guaraníes), heredados de Arfagi:

| Rango | Desde | Hasta |
|---|---|---|
| ACCESIBLE | ₲ 0 | ₲ 250.000 |
| MID | ₲ 250.001 | ₲ 500.000 |
| PREMIUM | ₲ 500.001 | ₲ 800.000 |
| LUJO | ₲ 800.001 | + |

### Índices nuevos a sumar

Para que la búsqueda del bot sea eficiente, agregar índices compuestos sobre:

- `perfume.gender` + `perfume.priceRange` + `status`
- `perfume.styleTags` (array-contains) + `status`

(Se agregan a `firestore.indexes.json` en F2.5.)

---

## 3. Estado de conversación (sesión del bot)

El tipo `Session` heredado ya tiene `state` (GREETING, BROWSING, VIEWING_PRODUCT, CART,
SELECTING_PAYMENT, AWAITING_PAYMENT, CHECKOUT_DONE, IDLE), `cart` y `context`. Sirve tal cual.

**Pendiente fase 4+ (bot real):** sumar el historial de mensajes del LLM al contexto de
sesión (para que el cerebro recuerde la conversación). Se decide al construir el `ClaudeBrain`.

---

## 4. Alcance de F2 (lo que falta hacer)

- [x] F2.1 — Inventario (este doc lo resume)
- [~] F2.2 — Diseño (este documento)
- [ ] F2.3 — Reglas: las heredadas ya cubren `products`. Verificar, sin cambios esperados.
- [ ] F2.4 — Seed: catálogo real de perfumería para el emulador de Firestore.
- [ ] F2.5 — Agregar `PerfumeAttributes` al tipo `Product` + índices + validar + commit.
