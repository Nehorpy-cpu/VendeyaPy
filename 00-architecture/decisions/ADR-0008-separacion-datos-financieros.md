# ADR-0008 — Separar datos financieros privados (`productFinancials` / `orderFinancials`)

**Fecha:** 2026-06-17
**Estado:** Aceptada (se implementa en P6 — fase activa)
**Decisores:** Owner del proyecto

---

## Contexto

Regla fundamental de Firestore (correctamente señalada por el spec):

> **Firestore no oculta campos individuales en una lectura.** Si un rol puede *leer* un documento,
> recibe **todos** los campos de ese documento. No se puede "esconder" un campo por reglas.

En P5 le dimos al rol **`SELLER`** permiso de lectura sobre `products` y `orders` (para que el
vendedor pueda atender). Pero:
- `costPrice` está **dentro** de `tenants/{t}/products/{id}`.
- `totals.totalCost`, `totals.grossProfit`, y por ítem `unitCost`/`grossProfit` están **dentro**
  de `tenants/{t}/orders/{id}` (y sus `items`).

La UI ya esconde costo/ganancia del vendedor (`{!isSeller && …}` en la página de pedidos), **pero
las reglas no**: un vendedor que consulte Firestore directamente (fuera de la pantalla) **podría
leer los costos y márgenes**. Es una fuga de datos sensibles a nivel de reglas.

> Severidad real hoy: baja (1 vendedora de confianza, sin producción, todo local). Pero **debe
> arreglarse antes de sumar vendedores reales o salir a producción.**

## Decisión

Mover los campos financieros a **colecciones privadas hermanas**, fuera de los documentos que el
vendedor puede leer:

```
tenants/{t}/products/{id}            ← visible (sin costPrice)
tenants/{t}/productFinancials/{id}   ← privado: costPrice, márgenes, descuento, priorityScore…
tenants/{t}/orders/{id}              ← visible (sin costo/ganancia)
tenants/{t}/orderFinancials/{id}     ← privado: subtotal, totalCost, grossProfit, margin…
```

- **Reglas:** `*Financials` → `read: if isTenantOwner || isPlatformAdmin` (y manager si aplica).
  **El vendedor NO puede leer `productFinancials` ni `orderFinancials`.** Escritura solo Admin SDK.
- **Mismo `id`** que el documento padre (1:1) para join trivial sin queries.
- **Snapshot histórico:** el costo al momento de la venta se guarda en el ítem del pedido
  (`unitCostSnapshot`/`totalCostSnapshot`) y en `orderFinancials`, para que cambios futuros de costo
  no alteren pedidos viejos (ya lo hacíamos parcialmente; se formaliza).
- **Cloud Functions** son las únicas que escriben finanzas (cálculo de orden, etc.), nunca el cliente.

## Impacto (archivos a tocar en P6)

- `packages/shared`: sacar `costPrice` de `Product`; sacar costo/ganancia de `Order`/`OrderItem`/
  `OrderTotals`; nuevos tipos `ProductFinancials` / `OrderFinancials`.
- `apps/functions`: `createPendingOrder` escribe `orderFinancials` (+ snapshots); cualquier lectura
  de costo pasa a la colección privada.
- `apps/web`: el form de producto guarda el costo en `productFinancials`; dashboard y márgenes
  (owner) leen de las colecciones privadas; el vendedor deja de poder pedirlas.
- `firestore.rules`: reglas para `productFinancials` y `orderFinancials` (deny a SELLER).

## Consecuencias

**Positivas:** el dinero queda realmente protegido (no solo escondido en la UI); cumple el criterio
de aceptación "los costos/ganancias no son visibles para sellers". **Negativas:** un documento extra
por producto/pedido y una lectura extra para el owner (barata, 1:1 por id). Ver ADR-0005 y ADR-0007.
