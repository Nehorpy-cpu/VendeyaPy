# Criterios de aceptación — AI_AFG

Checklist derivado del spec (sección "Criterios de aceptación"), cruzado con el estado real del
proyecto. Verificado con scripts en `apps/functions/scripts/` (corren contra los emuladores).

**Última actualización:** 2026-06-17 (cierre de P9 — Track B / panel núcleo completo).

## ✅ Cumplido (panel núcleo, P1–P9)

| Criterio | Estado | Evidencia |
|---|---|---|
| Usa Firestore correctamente (no SQL simulado) | ✅ | Todo el modelo es colecciones/subcolecciones |
| Cada empresa tiene sus datos aislados | ✅ | `verify-p9.mjs` (22/22): owner A no lee tenant B |
| Marco (Super Admin) ve todas las empresas | ✅ | `verify-p9` (Super Admin 200 en ambos tenants) |
| Owner solo ve su empresa | ✅ | reglas `isTenant*` por `tenantId` del token |
| Seller solo ve lo permitido | ✅ | `verify-p9` (vendedora 403 en lo privado) |
| Costos/ganancias NO visibles para sellers | ✅ | P6 + `verify-p6-rules.mjs`, `verify-p9.mjs` |
| Datos financieros en colecciones privadas | ✅ | `productFinancials` / `orderFinancials` (ADR-0008) |
| Mensajes en subcolección | ✅ | `customers/{c}/messages` (P5) |
| Ítems de pedido en subcolección | ✅ | `orders/{o}/items` |
| Dashboards con agregados (no lecturas masivas) | ✅ | `stats/public`+`private`, trigger (P7) |
| Catálogo local es la fuente principal | ✅ | P2 (catálogo en el panel) |
| Crear pedido desde conversación | ✅ | el bot crea la pre-orden (`createPendingOrder`) |
| Operar en modo demo/manual sin Meta | ✅ | todo funciona contra emuladores sin Meta |
| Reglas impiden fuga entre empresas | ✅ | `verify-p9.mjs` (aislamiento + roles + sin sesión) |
| Cloud Functions maneja lo sensible | ✅ | pedidos, handoff, stats, sugerencias (no en frontend) |
| Diseñado para bajo costo | ✅ | reglas + jobs + agregados; IA solo redacta (ADR-0006) |

## ⏳ Pendiente — depende de la integración con Meta (Track D) o refinamiento

| Criterio | Dónde se cumple |
|---|---|
| Tokens de Meta no en texto plano (Secret Manager) | **D1** (ADR-0009) |
| Webhooks guardados y procesados de forma segura | **D2** (`metaWebhookInbox` + TTL) |
| Meta Catalog se sincroniza desde nuestro sistema | **D4** |
| Campañas se leen desde Meta cuando hay permisos | **D3** |
| Conversaciones WhatsApp + Instagram + Messenger centralizadas | **D2** (hoy: modelo WhatsApp listo) |
| Atribución campaña → conversación → pedido → ganancia | **D5** (el diferencial) |
| Índices Firestore necesarios definidos/documentados | revisar `firestore.indexes.json` al sumar queries de Track D |

## Notas

- **Asignación de vendedores (P9):** el chat queda asignado al vendedor que lo toma
  (`assignedSellerId`) y hay filtro "Mis chats". El *enforcement* estricto a nivel de reglas
  (que un vendedor NO pueda leer chats de otro vendedor de la misma empresa) se difiere a cuando
  se opere con **varios vendedores** reales — hoy se arranca con uno (decisión del owner). Requiere
  un patrón de query "asignado a mí / sin asignar" (centinela) para no romper la bandeja compartida.
- **Cómo reproducir las pruebas:** encender los emuladores y correr, desde `apps/functions`,
  `node scripts/seed-users.mjs` + `node scripts/verify-p6.mjs` / `verify-p7.mjs` / `verify-p8.mjs` /
  `verify-p9.mjs`.
