# Instrucciones para Claude — Proyecto AI_AFG

> Estas instrucciones aplican a cualquier sesión de Claude Code que opere en `F:\AI_AFG\` o subdirectorios.

---

## Contexto del proyecto

`AI_AFG` es una plataforma multi-tenant para automatizar ventas vía WhatsApp en Paraguay.

**Scope actual (fase 1):** un solo tenant — **perfumería y cuidado personal femenino** (catálogo, promociones, checkout, posventa).

**Scope diferido (fase 2, no se desarrolla ahora):** un segundo tenant — **servicios financieros / créditos** vía CrediAgil / LlevaYa / Solar Banco. Ver `ADR-0002` para razón de diferimiento.

**Flujo crítico fase 1:** lead capturado en Meta Ads → conversación WhatsApp → cierre de venta → sin intervención humana en el camino feliz.

**Decisión arquitectónica clave:** aunque hoy solo se desarrolla perfumería, el backend conserva la arquitectura **multi-tenant** heredada de VentaporWhatsapp. Esto permite sumar el tenant de créditos en el futuro sin refactor — solo agregando un nuevo `tenant_id` + módulo específico en `80-creditos.future/`.

---

## Stack confirmado

- **Backend:** Node.js 20 + TypeScript + Firebase Cloud Functions
- **DB:** Cloud Firestore
- **Auth:** Firebase Authentication
- **Orquestación:** n8n self-hosted
- **WhatsApp:** WhatsApp Cloud API oficial de Meta (OpenWA descartado — ver ADR-0003)
- **Pagos:** Stripe internacional + pasarelas locales Paraguay (Bancard vPOS, Tigo Money, Personal Pay, Zimple) — ya documentadas en ARCHITECTURE.md heredado
- **Móvil:** Flutter (opcional, diferido)
- **Monorepo:** pnpm workspaces

---

## Convenciones inviolables

1. **`00-architecture/ARCHITECTURE.md` es la fuente única de verdad.** Si una decisión técnica contradice ese documento, primero se actualiza el documento (con su ADR), después se codea.
2. **Cada decisión técnica grande genera un ADR** en `00-architecture/decisions/ADR-NNNN-titulo.md`. Numeración correlativa.
3. **Carpetas numeradas:** `NN-nombre/`. `00-` es fundamento; `_archive/` y `docs/` no llevan número.
4. **`.env` nunca se commitea.** Cada subproyecto tiene su `.env.example`.
5. **Antes de tocar `_archive/`** pedir confirmación al usuario — contiene material previo de referencia.

---

## Lo que NO hay que hacer sin confirmación

- Borrar carpetas (en cualquier lugar)
- Modificar `C:\Users\Usuario\.claude\settings.json` (config global Claude — auto-modificación)
- Hacer `git push --force`, `git reset --hard` o `Remove-Item -Recurse -Force`
- Cambiar el stack confirmado sin ADR previo
- **Tocar `80-creditos.future/`** — está diferido, no se desarrolla en fase 1
- **Hardcodear "perfumería" en el backend.** Todo va con `tenant_id`. Si el código asume tenant único, se rompe la decisión de Opción C (ver ADR-0002)

---

## Habilitaciones que Claude SÍ puede hacer libremente

- Leer cualquier archivo
- Crear/editar archivos dentro de las subcarpetas numeradas (excepto `_archive`)
- Correr `pnpm install`, `pnpm dev`, `pnpm test`, `pnpm typecheck`
- Levantar y bajar containers con `docker compose` dentro de `90-ops/` o subcarpetas
- Crear ADRs en `00-architecture/decisions/`

---

## Heredado de instrucciones globales

- Fecha de referencia: 2026-06-10
- Idioma de interacción: español (rioplatense aceptado)
- Política Graphify: revisar `.git/hooks/post-commit` antes de proponer cambios si es un repo activo
