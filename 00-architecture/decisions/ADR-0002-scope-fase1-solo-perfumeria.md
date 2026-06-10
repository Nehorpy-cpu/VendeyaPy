# ADR-0002 — Scope fase 1: solo perfumería con arquitectura multi-tenant

**Fecha:** 2026-06-10
**Estado:** Aceptada
**Decisores:** Owner del proyecto

---

## Contexto

El owner opera dos negocios distintos en Paraguay:
1. Perfumería y cuidado personal femenino (B2C, e-commerce clásico).
2. Servicios financieros / créditos vía CrediAgil, LlevaYa y Solar Banco (B2C, regulado).

La pregunta inicial fue si automatizar ambos negocios con el mismo sistema desde el día 1.

Se evaluaron tres opciones:

| Opción | Descripción | Pros | Contras |
|---|---|---|---|
| A | Solo perfumería, código monolítico hardcoded para un negocio | Más rápido a producción (2-3 semanas) | Refactor grande (~50% backend) si se suman créditos después |
| B | Ambos negocios en paralelo desde día 1 | Una sola pasada de infra | 2-3x más tiempo a producción; compliance regulatoria de créditos compleja (KYC, AML, contratos digitales, registro INCOOP/BCP); riesgo de hacer ambos mal en vez de uno bien |
| C | Arquitectura multi-tenant heredada de VentaporWhatsapp + código solo para tenant perfumería | Salida a producción comparable a A (~3-4 semanas); sumar créditos en fase 2 sin refactor; aprovecha arquitectura ya escrita | Mínimo overhead inicial por mantener `tenant_id` en todo el código |

## Decisión

**Se elige Opción C.**

- El backend conserva la arquitectura multi-tenant heredada de VentaporWhatsapp.
- Se desarrolla **únicamente el tenant perfumería** en fase 1.
- El tenant créditos queda **diferido a fase 2** sin fecha definida.
- La carpeta `80-creditos/` se renombra a `80-creditos.future/` para señalizar que no se trabaja ahora.
- El workflow `07_credit_pipeline_creditos.json` se renombra a `.future.json` para que no se ejecute por error.
- Cuando se retome créditos, **no se requiere refactor**: solo agregar el nuevo `tenant_id` en Firestore + módulos específicos en `80-creditos.future/` (renombrada a `80-creditos/` al activarse).

## Consecuencias

**Positivas:**
- Foco total en perfumería sin sacrificar capacidad futura.
- Salida a producción de perfumería estimada en 3-4 semanas (vs 6-10 si fuese Opción B).
- Cero código tirado si en el futuro se suman créditos.
- Cero código tirado si nunca se suman créditos (perfumería igual queda funcionando con arquitectura multi-tenant que no estorba).

**Negativas / costos:**
- Todo el código del backend debe propagar `tenant_id` en queries, prompts del bot, eventos, etc. Estimación de overhead: 10-15% más de líneas vs un monolito puro.
- Las pruebas deben cubrir el caso de "tenant no autorizado" desde día 1 aunque solo haya un tenant.

## Reglas operativas derivadas

1. **Nunca hardcodear el tenant "perfumería"** en código del backend. Siempre se obtiene del contexto (número de WhatsApp destino, JWT, URL del webhook).
2. **No tocar `80-creditos.future/`** salvo para refactors estructurales del repo.
3. **Workflows N8N parametrizados por tenant** — los 5 workflows heredados ya están así.
4. **Schema Firestore con `tenants/{tenantId}/...` desde día 1**, incluso si hoy solo hay `tenants/perfumeria/`.
5. **El bot WhatsApp identifica tenant por número destino**, no por contenido del mensaje.

## Reversibilidad

Esta decisión es **fácilmente reversible**:
- Para reactivar créditos: renombrar `80-creditos.future/` → `80-creditos/` y `07_credit_pipeline_creditos.future.json` → `07_credit_pipeline_creditos.json`, escribir nuevo ADR con justificación, retomar tareas pendientes documentadas en README.
- Para colapsar a monolito perfumería (Opción A retrospectiva): se podría borrar la lógica multi-tenant, pero **no se recomienda** — costo de refactor inverso > beneficio.

## Acciones aplicadas en el repo

- [x] `80-creditos/` → `80-creditos.future/`
- [x] `20-n8n/workflows/07_credit_pipeline_creditos.json` → `.future.json`
- [x] `CLAUDE.md` actualizado con scope fase 1 y reglas operativas
- [x] `README.md` actualizado con tabla de fases y tareas separadas
- [x] Este ADR creado
