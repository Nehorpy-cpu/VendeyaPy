# @vpw/n8n-workflows

Workflows de n8n exportados como JSON, versionados en Git.

## Estructura

```
workflows/
├── WF-001-conversation-router.json
├── WF-002-catalog-flow.json
├── WF-003-cart-flow.json
├── WF-004-checkout-flow.json
├── WF-005-payment-confirmed-flow.json
├── WF-006-delivery-assign-flow.json
├── WF-007-delivery-status-flow.json
├── WF-008-abandoned-cart-flow.json
└── WF-009-report-flow.json
```

Ver ARCHITECTURE.md §7.3 para la descripción detallada de cada workflow.

## Exportar desde n8n

1. En la UI de n8n: abrir el workflow
2. Menú → Download
3. Guardar el JSON en `workflows/` con el nombre estandarizado

## Importar a n8n

1. UI de n8n → Workflows → Import from File
2. Seleccionar el JSON desde `workflows/`

## Deploy automático

El CI/CD usa la API REST de n8n para importar los workflows automáticamente al
deployar staging y producción. Ver `.github/workflows/deploy.yml`.
