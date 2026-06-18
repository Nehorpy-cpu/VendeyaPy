# @vpw/n8n-workflows

Tooling de **validación** de los workflows de n8n.

> **Fuente única de verdad: `20-n8n/workflows/`** (en la raíz del repo).
> Este paquete NO almacena los workflows; solo provee la validación (CI + local).
> Antes había una carpeta `workflows/` vacía acá que hacía validar "nada" — eliminada.

## Validar

```bash
pnpm --filter @vpw/n8n-workflows validate
```

Chequea que cada `*.json` de `20-n8n/workflows` sea JSON válido y tenga la estructura
mínima de n8n (`name`, `nodes`, `connections`). Soporta `_placeholder`. Corre en CI
(`.github/workflows/ci.yml`).

## Exportar / importar (n8n self-hosted)

- **Exportar:** en la UI de n8n → menú del workflow → *Download* → guardar el JSON en
  `20-n8n/workflows/` con su nombre (`0X_nombre.json`).
- **Importar:** UI de n8n → *Workflows → Import from File* (o vía la API REST de n8n
  como paso de deploy). Ver `20-n8n/README.md`.

> Nota: el import automático a n8n en el deploy NO está cableado todavía (n8n es
> self-hosted aparte de Firebase). Hoy el import es manual o por API.
