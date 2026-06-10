# tests

Tests de integración y E2E que cruzan múltiples paquetes.
Los tests unitarios viven dentro de cada paquete junto al código.

Ver ARCHITECTURE.md §8.

## Estructura

```
tests/
├── integration/       # Tests contra Firebase Emulator Suite
├── e2e/               # Flujos completos con Playwright
├── fixtures/          # Datos de prueba y payloads
│   ├── whatsapp-payloads/   # Webhook payloads de WA simulados
│   ├── bancard-payloads/    # Webhook payloads de Bancard
│   └── stripe-payloads/     # Webhook payloads de Stripe
└── helpers/           # Utilidades compartidas (seed, cleanup)
```

## Correr tests

```bash
# Integration (requiere emuladores corriendo)
pnpm emulators &
pnpm --filter tests test:integration

# E2E (requiere app corriendo)
pnpm --filter web dev &
pnpm --filter tests test:e2e
```
