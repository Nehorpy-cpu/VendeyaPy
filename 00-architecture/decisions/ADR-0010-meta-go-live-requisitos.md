# ADR-0010 — Requisitos de Meta para ir en vivo (verificación de plataforma vs conexión de cliente)

**Fecha:** 2026-06-18
**Estado:** Aceptada (aclaración de arquitectura; el sistema se construye "listo para conectar")
**Decisores:** Owner del proyecto

---

## Contexto

Pregunta del owner: ¿se puede construir el sistema para que **cualquier empresa** lo conecte a Meta
cuando tenga acceso — "enchufar y listo" — o se necesita **sí o sí** una cuenta de Meta verificada
antes de poder construir? Meta está bloqueado del lado del owner hoy.

## Decisión / Aclaración

Hay **dos accesos a Meta distintos** que NO hay que confundir:

1. **Nivel PLATAFORMA (AI_AFG), una sola vez.** La plataforma tiene **una App de Meta** registrada
   en developers.facebook.com. Para que sus permisos (whatsapp_business_messaging, instagram,
   pages, ads_read, catalog_management, business_management…) funcionen con **empresas de terceros**
   (no solo usuarios de prueba), la App necesita **App Review + Business Verification** del negocio
   dueño de la App. **Este es el único gate "duro" para producción.** Lo hace quien tenga autoridad
   sobre la App (el owner o alguien delegado como admin de la App), **no cada cliente**.

2. **Nivel CLIENTE (cada empresa, ej. perfumería).** Una vez la App de la plataforma está aprobada,
   cada empresa conecta su propio Meta con **OAuth ("Conectar con Facebook" → autorizar)**. No hace
   App Review; solo necesita tener su propio Meta Business + activos (WhatsApp Business, IG, Página,
   Ad Account). Para WhatsApp se usa **Embedded Signup** (modelo Tech Provider).

## Consecuencias para el desarrollo

- **Construir NO requiere Meta verificado.** Por eso el **Track D se hace en modo demo** (ADR-0009):
  modelo de datos, webhooks, sync de ads, atribución y UI quedan construidos y probados; la conexión
  real es una **capa fina reemplazable** (los endpoints `devMeta*` pasan a ser el OAuth real + token
  en Secret Manager via `tokenSecretRef`). Cuando Meta esté disponible → **enchufar, no rehacer**.
- **Probar el flujo real antes del App Review:** Meta permite **modo desarrollo** (número de prueba
  gratis + hasta ~5 destinatarios de prueba) sin verificación completa. Sirve para validar la
  integración real con un dev antes del review (ya previsto en ADR-0003 / F1).
- **Camino a producción (gate de Meta), una vez:** crear/configurar la App de la plataforma → agregar
  productos (WhatsApp/Login/etc.) → **Business Verification + App Review** de los permisos → activar
  modo Live. Recién ahí los clientes conectan su Meta con un clic.

## Resumen

| | Quién | Qué necesita | ¿Bloquea construir? |
|---|---|---|---|
| Plataforma | Owner / empresa dueña de la App (delegable) | App de Meta + Business Verification + App Review | No |
| Cada cliente | Dueño de la empresa | OAuth (un clic) + su propio Meta Business | No |

**Conclusión:** No se necesita el Meta verificado del owner para construir el sistema completo y
dejarlo listo. Lo único "sí o sí" para producción es la verificación/App Review **de la plataforma**
(una vez, delegable). Ver ADR-0009 (arquitectura Meta) y ADR-0003 (canal WhatsApp / modo desarrollo).
