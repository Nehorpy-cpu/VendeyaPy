# ADR-0005 — Panel SaaS multiempresa (admin) sobre Firestore + Next.js

**Fecha:** 2026-06-16
**Estado:** Aceptada
**Decisores:** Owner del proyecto

---

## Contexto

El owner vende este sistema como **SaaS a varias empresas**. Pidió un panel administrativo
profesional (CRM) con: empresas, usuarios/roles, catálogo, pedidos, clientes, conversaciones/bot,
campañas, vistas/analíticas, Promotion Strategy, configuración del agente y configuración de empresa.

El spec fue redactado en términos **MySQL/SQL** (tablas, migraciones), porque la tienda actual
(`arfagi.com`) es PHP+MySQL. Pero el sistema que ya construimos (agente, multi-tenant, catálogo,
pedidos, sesiones) corre en **Firebase/Firestore + Cloud Functions + TypeScript** (ADR-0001).

## Decisión

1. **Stack del panel: Firestore + Next.js** (Opción A). El panel + el agente viven en Firebase.
   Las "tablas SQL" del spec se implementan como **colecciones Firestore** (la mitad ya existe).
   Se conserva todo lo construido; el spec se cumple igual.
2. **El panel es la FUENTE DE VERDAD del catálogo.** La tienda PHP/MySQL queda como **vidriera**
   que **consume** el catálogo (vía API/sync, fase posterior). El admin de productos de la tienda
   PHP queda en modo solo-lectura/oculto. Sin doble edición.
3. **El panel se construye sobre `apps/web`** (Next.js 14 + React + Tailwind + Firebase SDK +
   TanStack Query + Zod — ya scaffoldeado).
4. **Roles (mapeo al modelo existente):**
   - Super Admin (Marco) = `PLATFORM_ADMIN`
   - Company Owner = `TENANT_OWNER`
   - Seller = `SELLER` (nuevo rol a agregar)
   - (`TENANT_MANAGER`/`TENANT_VIEWER` quedan disponibles pero el spec usa los 3 de arriba.)
5. **Seguridad multi-tenant estricta:** toda query filtra por `tenantId` (= `company_id`), salvo
   Super Admin. Enforcement en **backend** (firestore.rules + Cloud Functions), no solo en el frontend.

## Mapeo spec (MySQL) → AI_AFG (Firestore)

| Spec | Firestore | Estado |
|---|---|---|
| companies | `tenants/{tenantId}` | ✅ existe |
| users + role | claims `{tenantId, role}` + colección `users` | ✅ (falta rol SELLER) |
| products | `tenants/{t}/products` | ✅ (faltan `costPrice`, `aiNotes`) |
| categories | `tenants/{t}/categories` | ✅ |
| orders / order_items | `tenants/{t}/orders` | ✅ (faltan costo/ganancia, sellerId, source) |
| customers | `tenants/{t}/customers` | ✅ |
| conversations / messages | `customers/{c}/sessions` (+ falta historial messages) | 🔶 parcial |
| campaigns | `tenants/{t}/campaigns` | ❌ nuevo |
| store_views | `tenants/{t}/storeViews` | ❌ nuevo |
| promotions | `tenants/{t}/promotions` | ❌ nuevo |
| agent_settings | `tenants/{t}/config/*` (bancos+vendedores ya) | 🔶 parcial |

## Integración con la tienda PHP (consumidor)

- La tienda lee **solo productos `ACTIVE`** del tenant correspondiente, vía un endpoint/API
  que expone Firestore (ej. una Cloud Function pública por `company_slug`).
- No edita el catálogo. Documentar el contrato cuando se construya (depende de acceder al código PHP).

## Integración futura con Meta (campañas)

- Capa `CampaignDataProvider` (interfaz) → `ManualCampaignDataProvider` (hoy) → `MetaAdsDataProvider` (futuro).
- Las pantallas leen de la interfaz, nunca de Meta directo. Así se conecta Meta sin rehacer el frontend.

## Consecuencias

**Positivas:** se conserva todo lo hecho; multi-tenant/roles ya existen; el agente ya funciona;
`apps/web` está listo como lienzo. **Negativas / pendientes:** sumar colecciones nuevas (campaigns,
promotions, storeViews, messages) + campos (costPrice, ganancia); construir mucha UI; la integración
con la tienda PHP depende de acceder a su código (está en Hostinger).

## Reversibilidad

Media. Migrar a MySQL (Opción B) implicaría reescribir backend + agente. No es la dirección elegida.
