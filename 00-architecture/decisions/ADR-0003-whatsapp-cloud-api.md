# ADR-0003 — Canal WhatsApp: Cloud API oficial (descarte de OpenWA)

**Fecha:** 2026-06-10
**Estado:** Aceptada
**Decisores:** Owner del proyecto

---

## Contexto

Durante el armado del entorno se clonó y se intentó levantar **OpenWA**, un servidor
WhatsApp no oficial (automatiza WhatsApp Web vía librería). El build falló por
incompatibilidad de dependencias (vite 8 vs @vitejs/plugin-react 5) y quedó pendiente
de fix (fase F1 original).

Paralelamente, la arquitectura heredada de VentaporWhatsapp (`ARCHITECTURE.md` sección 1.2)
**ya especifica WhatsApp Cloud API oficial** como canal.

Se evaluó qué canal usar para todo el desarrollo en adelante.

| Criterio | OpenWA (no oficial) | WhatsApp Cloud API (oficial) |
|---|---|---|
| Riesgo de baneo del número | Alto — Meta puede bloquear | Nulo — canal oficial |
| Integración con Meta Business Suite | Indirecta / frágil | Nativa |
| Costo | Gratis (corre local) | Gratis hasta 1.000 conv/mes, luego por conversación |
| Estabilidad en producción | Media (depende de PC encendida) | Alta (infra Meta) |
| Coincide con arquitectura del proyecto | No | Sí |
| Setup | Docker + QR | Verificar Meta Business + número dedicado + tokens |

## Decisión

**Se adopta WhatsApp Cloud API oficial de Meta como ÚNICO canal de WhatsApp del proyecto.**

- **OpenWA se descarta.** Se movió de `50-whatsapp-server/OpenWA/` a `_archive/OpenWA-descartado/`
  (no se borra: queda como posible herramienta de testing local futura).
- La carpeta `50-whatsapp-server/` se renombró a `50-whatsapp-cloud-api/`.
- La fase **F1 del roadmap deja de ser "fix OpenWA"** y pasa a ser **"Setup de WhatsApp Cloud API"**.

## Consecuencias

**Positivas:**
- Cero riesgo de baneo — crítico para un negocio real.
- Integración nativa con Meta Business Suite (objetivo declarado del owner).
- Coherencia total con la arquitectura heredada.
- No se mantiene un servidor propio 24/7.

**Negativas / costos:**
- Requiere trámites con Meta: verificación de Meta Business, número dedicado, app, tokens.
- Costo por conversación una vez superadas las 1.000/mes gratis (aceptable para el modelo de negocio).
- El número dedicado NO puede ser un WhatsApp personal ni un WhatsApp Business app normal —
  debe registrarse en la plataforma de WhatsApp Business API.

## Estado del owner (al momento de la decisión)

- Tiene cuenta de Meta Business, pero **no está confirmado si está verificada**.
- Primera sub-fase de F1: verificar estado de Meta Business antes de avanzar.

## Acciones aplicadas en el repo

- [x] OpenWA movido a `_archive/OpenWA-descartado/`
- [x] `50-whatsapp-server/` renombrada a `50-whatsapp-cloud-api/`
- [x] README del canal creado
- [x] Roadmap F1 reescrito (setup Cloud API en vez de fix OpenWA)
- [x] Este ADR creado

## Reversibilidad

Reversible con bajo costo: OpenWA está intacto en `_archive/OpenWA-descartado/`.
Si Cloud API resultara inviable (ej. Meta rechaza la verificación), se puede retomar
OpenWA aplicando el fix de vite documentado en el historial de esta sesión.
