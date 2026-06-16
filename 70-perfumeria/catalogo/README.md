# Catálogo de Perfumería — Carga de productos

Cómo cargás tus perfumes al sistema para que el agente de IA los conozca y recomiende.

---

## Flujo

```
plantilla-catalogo.csv  →  node import-catalogo.mjs  →  seed-productos.json  →  (F3) Firestore  →  el agente
   (lo llenás vos)            (valida y normaliza)        (listo para cargar)                    (recomienda)
```

---

## 1. Llenar la plantilla

Abrí `plantilla-catalogo.csv` en Excel o Google Sheets. Una fila por perfume.

| Columna | Obligatorio | Ejemplo | Notas |
|---|---|---|---|
| `sku` | No | (vacío) | Si lo dejás vacío, se genera solo (marca-nombre) |
| `nombre` | **Sí** | Good Girl | |
| `marca` | **Sí** | Carolina Herrera | |
| `genero` | **Sí** | Femenino | Solo: Femenino, Masculino, Unisex |
| `familia_olfativa` | No | Oriental Floral | |
| `estilos` | No | dulce;intenso;floral | Separá con `;` |
| `notas_salida` | No | bergamota, almendra | Notas de salida |
| `notas_corazon` | No | jazmín, tuberosa | Notas de corazón |
| `notas_fondo` | No | cacao, vainilla | Notas de fondo |
| `precio_gs` | **Sí** | 565000 | Solo números, en Guaraníes |
| `tamano_ml` | No | 80 | |
| `stock` | No | 4 | |
| `destacado` | No | si | si/no |
| `nuevo` | No | no | si/no |
| `descripcion` | No | Icónico y seductor... | |
| `imagen_url` | No | https://... | |

> 💡 Si un campo tiene comas (ej. una descripción), ponelo entre comillas dobles: `"Texto, con comas"`.

---

## 2. Importar

Desde esta carpeta:

```
node import-catalogo.mjs
```

Genera `seed-productos.json` con tus productos validados y normalizados, y te avisa
si alguna fila tiene errores (género inválido, precio faltante, etc.).

Para usar otro archivo: `node import-catalogo.mjs mi-archivo.csv`

---

## 3. Cuando tengas tu catálogo de Meta / Instagram Shop

Tu catálogo ya está en Meta. Cuando recuperes el acceso:

1. En **Meta Commerce Manager** → tu catálogo → **Exportar productos** (te da un CSV/feed).
2. Ese CSV tiene columnas de Meta (`title`, `description`, `price`, `image_link`, etc.).
3. Mapeás esas columnas a las de nuestra plantilla (o te armo un script que lo haga
   automáticamente cuando veamos el formato exacto de tu export).
4. Las notas olfativas y estilos probablemente no estén en Meta → los completás en la
   plantilla (es lo que hace al agente bueno recomendando).

En la **fase 7** conectamos la sincronización en ambos sentidos con Meta.

---

## Notas técnicas

- El importador hoy corre en **dry-run**: valida y genera el JSON. La carga real a
  Firestore se conecta en **F3** (cuando esté el emulador/proyecto Firebase).
- El formato de salida respeta el tipo `Product` + `PerfumeAttributes`
  (ver `docs/data-model-perfumeria.md`).
- `seed-productos.json` es generado — no se edita a mano (y está en `.gitignore`).
