# CI / Calidad — AI_AFG

Pipeline de verificación del monorepo (`10-backend/`). El mismo set corre en
GitHub Actions (`.github/workflows/ci.yml`) y localmente.

## Requisitos
- **Node 20** (ver `.nvmrc` en la raíz). Cloud Functions exige Node 20; usá `nvm use`.
- **pnpm 9** (`corepack enable` o instalación global).

## Verificación completa (local)
Desde `10-backend/`:

```bash
pnpm install --frozen-lockfile
pnpm typecheck   # tsc --noEmit en todos los paquetes
pnpm lint        # ESLint (functions/shared) + next lint (web)
pnpm test        # vitest (unit + integración). NO corre E2E.
pnpm build       # tsc (functions/shared) + next build (web)
```

> ⚠️ No corras `pnpm build` (incluye `next build`) mientras `next dev` está
> levantado: ambos escriben en `apps/web/.next` y se corrompe el cache del dev
> server. Pará el dev, buildeá, borrá `.next` y volvé a levantar el dev.

## Tests
- `pnpm test` corre unit + integración con Vitest y **pasa aunque un paquete no
  tenga tests** (`--passWithNoTests`).
- E2E (Playwright) queda fuera del `test` por defecto. Para correrlo:
  `pnpm --filter tests test:e2e`.

## Lint
- `apps/functions` y `packages/shared` usan la config raíz `10-backend/.eslintrc.cjs`
  (`@typescript-eslint`). Los hallazgos de estilo salen como **warnings** (no
  bloquean CI); se limpian progresivamente.
- `apps/web` usa `next/core-web-vitals`.

## n8n
`node scripts/validate-n8n.mjs` (desde la raíz del repo) valida que los workflows
en `20-n8n/` sean JSON parseable.
