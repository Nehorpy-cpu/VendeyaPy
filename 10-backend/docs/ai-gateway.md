# AI Gateway (Claude Haiku) — arquitectura y data policy

Capa backend que integra **Claude Haiku 4.5** por tenant. Es el **único punto que habla con Claude**.

## Principios de seguridad
- El **frontend nunca** llama a Claude. Solo el backend (`apps/functions/src/ai/`).
- **Claude no lee Firestore directo.** Solo recibe `system`/`messages`/`tools` que arma el backend; las tools corren server-side.
- El **`tenantId` lo resuelve el backend** (auth para el panel, `metaExternalIndex` para el webhook). Las tools **ignoran** cualquier `tenantId` que venga del modelo o del cliente.
- La **API key** vive solo en backend (`ANTHROPIC_API_KEY`); nunca se loguea ni va al frontend. En emulador/tests se usa un **cliente fake** (cero red).

## Contextos
| Contexto | Entrada | tenantId | Datos |
|---|---|---|---|
| `whatsapp_sales_agent` | Webhook WhatsApp (cliente final — **texto no confiable**) | de `metaExternalIndex` | catálogo público + promos |
| `internal_growth_assistant` | Callable del panel (owner/admin) | de `req.auth` | agregados del **propio** tenant (incl. margen) |

## Data policy
**`whatsapp_sales_agent` — PERMITIDO:** productos activos con stock (nombre, marca, precio, estilo, disponibilidad), promociones activas (campos públicos), `tone`/`salesRules`/`faq` del agente.
**PROHIBIDO (nunca al modelo):** costos, márgenes, ganancias, ventas internas, métricas privadas, campañas Meta, datos de otros clientes, datos de **otros tenants**, tokens/secrets. → la búsqueda corre con `profitMode:false` y la salida pasa por un **sanitizador con whitelist** (`sanitizeProduct`/`sanitizePromotion`).

**`internal_growth_assistant` — PERMITIDO (read-only, propio tenant):** ventas/ingresos/ticket, ganancia/margen, top productos (`stats/public` + `stats/private`).
**PROHIBIDO:** writes/acciones; datos de otros tenants.

## Capa de tools (`apps/functions/src/ai/tools/`)
- **Registry/allowlist** (`registry.ts`): `toolsForContext` / `toolDefinitionsForContext` / `executeTool`. Una tool fuera del allowlist del contexto → not-found (no se ejecuta). `executeTool` corre con el `tenantId` del contexto.
- **Sales** (`salesTools.ts`, read-only): `buscar_productos`, `listar_promociones_activas`.
- **Internal** (`internalTools.ts`, read-only): `resumen_ventas`.
- **`crear_borrador_pedido`**: es un **write** → **deshabilitado** (solo contrato exportado, fuera de todo registry). Sigue deshabilitado en AG-3; los writes de pedidos quedan para una fase posterior tras auditar el modelo de orden.
- **Sanitizadores** (`sanitize.ts`): construyen objetos nuevos por whitelist (sin spread del doc original).

## Gateway core (AG-1)
- `gateway.ts` `runAgent(input, deps)` — modelo `claude-haiku-4-5`; nunca lanza (status `ok`/`error`/`disabled`) → el caller hace **fallback al motor rule-based**.
- `client.ts` — `AiClient` inyectable: real (`@anthropic-ai/sdk`) con timeout+retries; fake (fixtures `aiTestFixtures/ai`) en emulador. Sin API key en prod → `disabled` (sin crash).
- `pricing.ts` — costo aproximado por constante (Haiku $1/$5 por 1M).

## Auditoría
`tenants/{t}/aiRequests/{id}`: solo metadatos (context, status, tokens, costo, latencia, tools, `errorCode` seguro). **Nunca** guarda el system prompt, los mensajes ni PII. Rules (AG-3, igual que `agentAudits`): `write: if false` (solo Admin SDK), `read: manager+/admin` (el vendedor NO lee — contiene costos).

## Integración en el bot (AG-3)
`salesAgent.ts` `runSalesAgent({tenantId, agentConfig, messages})` envuelve `runAgent` para el contexto sales:
1. **Gate** `assertAiBudget(tenantId, ~tokens)` (feature `aiAssistant` + cuota `aiTokens`) **antes** de llamar. Falla → fallback.
2. `runAgent` con `buildSalesSystemPrompt`, las tools sales y un `executeTool` que enruta al `registry.executeTool('whatsapp_sales_agent', tenantId, …)`.
3. `status!=='ok'` / reply vacío (sin key, Claude falló, texto inválido) → fallback.
4. **Metering** `recordAiUsage(tenantId, inTok+outTok, costUsd)` **después** (best-effort; no rompe la respuesta).

**Ruteo en `engine.ts handleMessage`:** solo los turnos que el motor rule-based mandaría a su **fallback genérico** (no saludo, no carrito/pagar/seleccionar, no catálogo) se delegan al agente IA — **advisory**: responde solo con info pública y **no** toca carrito/pedido/estado. El flujo de conversión (navegar → elegir por número → carrito → pagar) y su `lastShownSkus` quedan 100% en las reglas. Si la IA está off / sin cupo / falla → el turno cae al motor rule-based (el bot nunca queda mudo).

## Orden por sub-fases
- **AG-1** (cerrado): gateway core.
- **AG-2** (cerrado): contextos + data policy + tool/data layer (read-only).
- **AG-3** (cerrado): sales agent cableado en `handleMessage` detrás de `aiAssistant`+env, con loop de tool-use, fallback rule-based, metering (`assertAiBudget`/`recordAiUsage`) y rules de `aiRequests`. e2e fixture-driven: `scripts/verify-ai-gateway.mjs`.
- **AG-4**: callable del internal assistant (sin UI todavía).
- **AG-5**: e2e completo con fake client (no-leak, isolation, fallback, simulador).
