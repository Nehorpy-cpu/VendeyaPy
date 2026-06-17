# Guía: Backend con IA / Agentes (AI Backend Architect)

> **Cuándo usar esta guía:** al construir APIs, webhooks, jobs/workers, pipelines RAG,
> orquestación de modelos o lógica de agentes con IA en AI_AFG.
> Referenciada desde `CLAUDE.md`. **Adaptada a nuestro stack real** (Firebase/Firestore +
> Cloud Functions + n8n + WhatsApp Cloud API), no a un stack SQL genérico.

## Misión

Construir backends de IA **confiables, seguros, observables y mantenibles** — pensados para
usuarios reales, fallas reales, costos reales e iteración futura. No endpoints de juguete
(salvo que se pida un prototipo explícito).

## Principios

- Entender el flujo del producto antes de elegir arquitectura.
- Separar: API de cara al cliente · lógica de negocio · orquestación de modelos · persistencia · jobs.
- Tratar las llamadas a IA como **dependencias externas no confiables**: reintentos, timeouts, fallas parciales, rate limits, errores de proveedor.
- **Persistir el estado importante antes y después** de operaciones caras de IA. Nunca depender solo de memoria.
- Preferir **salidas estructuradas** cuando el código aguas abajo depende del resultado.
- Prompts **centralizados/versionados** cuando controlan comportamiento importante (hoy: `conversation/engine.ts` → `SYSTEM_PROMPT`).
- Nunca exponer API keys, system prompts, datos privados ni razonamiento interno.

## Capas (mapeadas a NUESTRA estructura)

| Capa genérica | Dónde vive en AI_AFG |
|---|---|
| routes / controllers (validar, auth, llamar servicios) | `apps/functions/src/functions/**` (handlers `onRequest`) |
| services (lógica de negocio) | `apps/functions/src/conversation/`, `apps/functions/src/catalog/` |
| ai / agents (prompts, tools, llamadas a modelo, salida estructurada) | `conversation/engine.ts` (punto de extensión `decidirRespuesta`); futuro `ai/` o `agents/` |
| db / repositories | `apps/functions/src/lib/firebase.ts` (`db()`, `paths`) |
| jobs / workers (async) | n8n (`20-n8n/`) + futuros triggers Pub/Sub / Cloud Tasks |
| lib (config, logging, errores) | `apps/functions/src/lib/` |

Evitar llamadas a modelo directamente dentro de un handler de ruta salvo que la app sea muy chica.

## Diseño de API

Para cada endpoint:
- Validar input con schema (zod ya está disponible).
- Exigir autenticación cuando hay datos de usuario o uso pago de IA.
- Verificar autorización por dueño/tenant/org.
- Forma de error consistente; **no filtrar errores crudos del proveedor** al cliente.
- Idempotencia (claves) en operaciones caras o repetibles.
- Paginación en listas.
- Estados claros para trabajo async: `queued` · `running` · `completed` · `failed` · `cancelled`.

## Orquestación de IA (cuando se enchufe el modelo real)

- Fijar explícitamente: modelo, temperature, max tokens, timeout.
- Usar **salida estructurada** cuando el resultado alimenta código/DB/tools/UI.
- **Validar la salida del modelo** antes de confiar en ella (rechazo, JSON malformado, vacío, timeout, error de proveedor).
- Guardar metadata de cada corrida: modelo, versión de prompt, tokens, latencia, estado, id de usuario/job.
- No loguear contenido sensible salvo que sea aceptable para el producto.
- Ver también la skill `claude-api` para detalles del SDK de Claude + prompt caching (ya elegido para abaratar — ver decisión de costos).

## Sistemas con agentes

- Definir objetivo del agente, tools permitidas y condiciones de parada.
- **Limitar** cantidad de tool-calls / iteraciones (hoy el simulador ya tiene `MAX_ITERS`).
- Validar input de las tools; tratar su output como **no confiable**.
- **Gates de aprobación humana** para acciones de alto impacto: enviar dinero, borrar datos, publicar contenido, modificar producción.
- Persistir pasos/eventos del agente para debugging y progreso visible.
- Salvaguardas contra loops, acciones duplicadas y costos descontrolados.

## RAG / Conocimiento (catálogo y futuro vector)

- Guardar documentos fuente con metadata; chunking intencional (no a ciegas).
- Rastrear ids de fuente / títulos / URLs.
- Embeddings solo para recuperación, **no como fuente de verdad**.
- Devolver **citas** al responder desde contenido recuperado; separar hechos recuperados de la interpretación del modelo.
- Manejar explícitamente "no hay suficiente evidencia".
- Estrategia de reindexado cuando las fuentes cambian (ej: sync MySQL `products` de la tienda PHP → Firestore, ADR-0004).

## Datos (Firestore — NO SQL)

> **Adaptación:** usamos **Firestore (NoSQL)**, no tablas SQL. No hay "migraciones" SQL;
> el "esquema" se versiona en los **types de `@vpw/shared`** y en `ARCHITECTURE.md §4`.

Colecciones actuales: `tenants/{t}` → `products`, `categories`, `customers/{c}/sessions`, `orders`, `payments`, `invoices`.
Colecciones a sumar cuando entre la IA real: `ai_runs`, `ai_run_steps`, `tool_calls`, `usage_events` (bajo el tenant o a nivel plataforma según corresponda).
Cambios de "esquema" = actualizar types + ARCHITECTURE.md + ADR si es decisión grande.

## Jobs async

Usar trabajo en segundo plano cuando: la generación tarda más de unos segundos, hay parsing/indexado/embedding, varias llamadas a modelo/tool, o el usuario necesita progreso.
- Crear el registro de job primero → devolver job id → procesar en worker (n8n / trigger) → persistir progreso y resultado → reintentos con límite e **idempotentes** → marcar fallas claramente.

## Seguridad (refuerza ADR-0002 multi-tenant)

- Secrets en variables de entorno / secret manager; **keys server-side only** (nunca en cliente).
- Validar firmas de webhook (ya existe `verifyMetaSignature`).
- Sanitizar uploads (tamaño/tipo).
- **Aislamiento de tenant en CADA query** (`tenantId`).
- Protección contra **prompt injection** en documentos recuperados, outputs de tools y mensajes de usuario: el texto recuperado NUNCA debe pisar instrucciones de sistema.
- Rate-limit y controles de abuso en endpoints de IA.

## Costos (alineado con la preocupación del owner)

- Límites de uso por usuario/org/plan; trackear tokens y operaciones caras.
- Cachear resultados deterministas/repetidos (prompt caching de Claude ya elegido).
- Modelos más baratos para clasificación/extracción cuando alcanza (Haiku).
- No mandar contexto innecesario; truncar/resumir/recuperar selectivamente.
- Fallar con gracia al exceder cuota.

## Observabilidad

Loguear (con el `logger` de `lib/logger.ts`, sin secretos ni contenido sensible): fallas de API, run de IA started/completed/failed, latencia del proveedor, uso de tokens, tool calls, fallas de cola/webhook, fallas de autorización.

## Testing (vitest ya disponible)

Tests para: validación de input, autorización, parseo de salida de IA, límites de ejecución de tools, transiciones de estado de jobs, firma de webhooks, reglas de acceso a DB, y **casos de falla** (timeout, JSON malformado, error de proveedor, sin contexto de RAG, webhook/job duplicado). **Mockear el proveedor de IA** en tests.

## Flujo de implementación

1. Inspeccionar la estructura del backend. 2. Identificar framework/ORM/auth/DB/cola/SDK de IA. 3. Leer rutas/servicios/schema/config relevantes. 4. Diseñar el flujo mínimo seguro para producción. 5. Implementar con límites de capa claros. 6. Agregar validación, errores y persistencia. 7. Agregar/actualizar tests. 8. Correr typecheck/lint/tests/build. 9. Resumir arquitectura, archivos, verificación y riesgos.

## Atajos PROHIBIDOS

No: poner API keys en el frontend · guardar estado de workflow de IA solo en memoria · confiar en output de modelo sin validar · saltear auth en endpoints de IA · dejar que agentes ejecuten acciones destructivas automáticamente · esconder errores del proveedor sin loguear · falsear streaming/progreso de jobs · declarar "listo para producción" sin tests ni verificación.
