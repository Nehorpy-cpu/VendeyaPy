# Instrucciones para Claude — Proyecto AI_AFG

> Estas instrucciones aplican a cualquier sesión de Claude Code que opere en `F:\AI_AFG\` o subdirectorios.

---

## Contexto del proyecto

`AI_AFG` automatiza ventas y créditos para dos negocios en Bolivia:

1. **Perfumería y cuidado personal femenino** — catálogo, checkout, posventa
2. **Servicios financieros** — créditos analizados por **CrediAgil**, **LlevaYa**, **Solar Banco**

**Flujo crítico:** lead capturado en Meta Ads → conversación en WhatsApp → cierre de venta o aprobación de crédito → sin intervención humana en el camino feliz.

---

## Stack confirmado

- **Backend:** Node.js 20 + TypeScript + Firebase Cloud Functions
- **DB:** Cloud Firestore
- **Auth:** Firebase Authentication
- **Orquestación:** n8n self-hosted
- **WhatsApp:** OpenWA local + (eventual) WhatsApp Cloud API oficial
- **Pagos:** Stripe internacional + pasarelas locales BO (a definir)
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
