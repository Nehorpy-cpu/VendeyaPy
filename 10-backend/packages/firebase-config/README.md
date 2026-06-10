# @vpw/firebase-config

Las reglas e índices reales viven en la raíz del repo:

- [`/firestore.rules`](../../firestore.rules)
- [`/firestore.indexes.json`](../../firestore.indexes.json)
- [`/storage.rules`](../../storage.rules)

Este paquete existe para correr tests de reglas con `@firebase/rules-unit-testing`
y agruparlos en el monorepo.

## Tests

```bash
# Requiere emuladores de Firebase corriendo
pnpm --filter @vpw/firebase-config test:rules
```
