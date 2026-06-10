# ADR-0001 — Base stack y consolidación de proyectos previos

**Fecha:** 2026-06-10
**Estado:** Aceptada
**Decisores:** Owner del proyecto

---

## Contexto

Antes de iniciar `AI_AFG` existían dos intentos previos del mismo sistema:

1. **VentaporWhatsapp** (`F:\Proyectos\VentaporWhatsapp`) — monorepo Node.js + Firebase + Firestore + n8n, con `ARCHITECTURE.md` v1.0.0 ya redactado. Apuntaba a Paraguay.
2. **Proyecto_Arfagi** (`F:\Proyectos\Proyecto_Arfagi`) — backend Python + N8N con 5 workflows ya armados + Flutter SDK + CRM propio.

Tener ambos activos llevaría a duplicación y deuda técnica.

## Decisión

1. **Base del backend:** se adopta **VentaporWhatsapp** completo como base de `10-backend\`.
2. **Stack confirmado:** Node.js 20 + TypeScript + Firebase Functions + Firestore + n8n + Stripe + WhatsApp Cloud API.
3. **Workflows N8N:** se heredan los 5 workflows de `Proyecto_Arfagi\N8N\` a `20-n8n\workflows\` y se reusan/adaptan.
4. **Adaptaciones necesarias en `ARCHITECTURE.md`:**
   - País: Paraguay → **Bolivia**
   - Pagos locales: Bancard/Tigo Money/Personal Pay/Zimple → revisar pasarelas locales BO (MercadoPago, Tigo Money BO, etc.)
   - Facturación: SET Paraguay → SIN/Impuestos Internos Bolivia
   - Tenants iniciales: **perfumería** y **créditos**
   - Entidades de crédito a integrar: **CrediAgil**, **LlevaYa**, **Solar Banco**
5. **Lo no adoptado:** servicios Python de `Proyecto_Arfagi`, su CRM propio y Flutter SDK quedan en `_archive\` por si se canibaliza algo más adelante.

## Consecuencias

**Positivas:**
- Arranque rápido — la arquitectura ya está escrita.
- Stack moderno y mantenible.
- Heredamos 5 workflows N8N ya armados.

**Negativas:**
- Hay que rehacer las secciones país-específicas de `ARCHITECTURE.md` (pasarelas, facturación, regulación).
- Si en el futuro hace falta scoring ML pesado, habrá que reintroducir microservicios Python (decisión diferida).

## Acción pendiente

- [ ] Reescribir secciones país-específicas de `ARCHITECTURE.md` (sección 1.2 stack, sección 6 WhatsApp, sección 9 despliegue)
- [ ] Agregar capítulo nuevo: "Integración con entidades de crédito (CrediAgil / LlevaYa / Solar Banco)"
- [ ] Documentar tenants iniciales (perfumería y créditos) en sección 2 Multi-Tenant
