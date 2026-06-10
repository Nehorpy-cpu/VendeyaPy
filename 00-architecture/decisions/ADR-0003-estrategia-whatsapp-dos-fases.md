# ADR-0003 — Estrategia WhatsApp en dos etapas: OpenWA → Cloud API

**Fecha:** 2026-06-10
**Estado:** Aceptada
**Decisores:** Owner del proyecto

---

## Contexto

El `ARCHITECTURE.md` heredado especifica **WhatsApp Cloud API oficial** como capa de mensajería. Sin embargo, durante el setup se instaló y dejó corriendo **OpenWA** (cliente no oficial basado en WhatsApp Web), con una sesión activa migrada a `50-whatsapp-server/OpenWA/data/`.

Esto generaba una contradicción entre la fuente de verdad y la realidad del repo, que había que resolver antes de codear el bot.

Diferencias clave:

| Criterio | OpenWA (no oficial) | Cloud API (oficial Meta) |
|---|---|---|
| Costo | Gratis | Gratis hasta 1K conv/mes, luego por uso |
| Riesgo de baneo | Alto (Meta puede banear el número) | Nulo |
| Conexión con Meta Business Suite / ads | Limitada | Nativa (Click-to-WhatsApp, CAPI, catálogo) |
| Setup | Inmediato (ya corriendo) | Requiere cuenta Meta Business verificada + número + aprobación (1-3 días) |
| Estabilidad producción | Frágil | Sólida |

## Decisión

**Estrategia de dos etapas:**

1. **Etapa de prototipado (ahora):** usar **OpenWA** para construir y validar el bot conversacional rápidamente, sin esperar trámites de Meta. Aprovecha la sesión ya activa.
2. **Etapa de producción (antes de invertir en ads):** **migrar a WhatsApp Cloud API oficial** una vez que el bot funcione end-to-end. Esto se hace ANTES de conectar Meta Business Suite y correr campañas pagas, para evitar el riesgo de baneo sobre un número que ya tiene tráfico de ads detrás.

## Implicancia de diseño crítica

Para que la migración OpenWA → Cloud API en etapa 2 NO requiera reescribir el bot, **toda la lógica de mensajería debe ir detrás de una interfaz/abstracción** (`packages/whatsapp-client/` o similar). El bot habla con esa interfaz, no con OpenWA directamente.

- `WhatsAppClient` (interfaz) → `OpenWAAdapter` (etapa 1) → `CloudAPIAdapter` (etapa 2)
- Cambiar de adapter NO debe tocar la lógica conversacional ni el checkout.

Esto es regla inviolable derivada de este ADR.

## Consecuencias

**Positivas:**
- Empezamos a construir el bot HOY, sin bloqueo por trámites.
- La migración futura es de bajo costo si respetamos la abstracción.
- El número con ads detrás (etapa 2) nace directo en el canal oficial, sin riesgo de baneo.

**Negativas:**
- Hay que diseñar la capa de abstracción desde el inicio (pequeño overhead).
- Habrá un momento de migración (testing del CloudAPIAdapter) antes de producción.
- Los mensajes/flujos probados en OpenWA deben re-validarse en Cloud API (formatos de mensaje difieren: templates, botones interactivos, etc.).

## Acción pendiente

- [ ] Actualizar `ARCHITECTURE.md` sección 6 (WhatsApp) para reflejar la estrategia de dos etapas y la capa de abstracción (F1.1)
- [ ] Al diseñar el bot (F3), implementar `WhatsAppClient` como interfaz con `OpenWAAdapter` primero
- [ ] Antes de F5 (ads/Meta), ejecutar la migración a `CloudAPIAdapter`
