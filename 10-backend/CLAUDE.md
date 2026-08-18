@AGENTS.md

# VendeYaPy — instrucciones para Claude Code

Las reglas duras del proyecto están arriba, importadas de `AGENTS.md`. Este archivo agrega
solo lo específico de Claude Code. Si algo de acá contradice a `AGENTS.md`, gana `AGENTS.md`.

## Arranque obligatorio de sesión

Antes de responder cualquier pedido de trabajo, leé en este orden:

1. `docs/ESTADO.md` — el presente del sistema. Nunca asumas el estado de memoria.
2. Las últimas 3 entradas de `docs/BITACORA.md` — qué pasó recientemente y qué quedó abierto.

Si `ESTADO.md` tiene una fecha de más de 7 días o marcas `⚠️ verificar`, decilo antes de
trabajar. Un estado desactualizado es la causa raíz de la mayoría de los errores de deploy
de este proyecto.

## Ciclo de trabajo

Toda fase sigue este ciclo. No se saltan pasos ni se reordenan.

1. **Coordinación** — el subagente `coordinador` (solo lectura) audita el estado, los riesgos
   y las dependencias, y redacta el prompt técnico de la fase. Se invoca con `/nueva-fase`.
2. **Auditoría** — antes de modificar nada, auditar el repositorio: leer el código real,
   no inferirlo. Reportar hallazgos antes de escribir la primera línea.
3. **Implementación** — el cambio más pequeño compatible con la arquitectura existente.
   Nada de refactors oportunistas. Conservar los cambios existentes del usuario.
4. **Verificación** — como mínimo `pnpm -r typecheck`, lint, tests relacionados, E2E y las
   regresiones que toque la superficie modificada. Los números se reportan, no se resumen
   con "todo verde".
5. **Review adversarial** — cuando el cambio toca dinero, pedidos, pagos, privacidad,
   multi-tenant, deploy o rollback. Revisor fresco, no la misma sesión que escribió el código.
6. **Commit y push. NUNCA deploy.** El deploy lo autoriza el owner explícitamente, siempre.
7. **Cierre** — `/cerrar-fase` emite el reporte y actualiza `docs/ESTADO.md` y
   `docs/BITACORA.md`.

## Modo plan

Usar modo plan (Shift+Tab dos veces) obligatoriamente antes de tocar:

- cualquier ruta bajo `functions/` que participe del webhook, checkout, pedidos o pagos
- Firestore Rules, Storage Rules o índices
- `build-deploy.mjs`, los scripts `deploy:*` o cualquier runbook de `docs/`
- la configuración por tenant (`config/*`)

## Formato del reporte de fase

Todo trabajo cierra con estos 9 campos. Sin excepción, aunque la fase haya sido corta:

1. Qué se auditó
2. Causa raíz
3. Cambios realizados
4. Archivos o módulos afectados
5. Tests y regresiones (con números reales)
6. Commit
7. Estado de deploy
8. Riesgos o pendientes
9. Próximo prompt recomendado

## Honestidad de estado

Este proyecto distingue tres estados y jamás los mezcla:

- **EN REPO — NO DESPLEGADO**: el código existe y está probado, producción no lo tiene.
- **EN PROD — INERTE**: desplegado con el flag apagado. Desplegado ≠ activo.
- **EN PROD — ACTIVO**: desplegado y encendido, con smoke real aprobado.

Nunca declares una fase "completa" porque los tests pasan. Completa significa validada en
producción con evidencia. Si algo se probó en emulador y no en prod, se dice así, con esas
palabras. Si un número no se verificó en esta sesión, se marca `⚠️ verificar` en vez de
repetirlo de memoria.

## Selector de deploy

Cuando propongas un deploy, escribí siempre el selector exacto: qué functions son CREATE,
cuáles UPDATE, cuáles DELETE, en qué orden (consumidores primero, productores último), y el
selector de rollback, que es **el mismo menos las CREATE** — si incluís una CREATE en el
rollback, `firebase deploy` aborta el comando entero porque ese export no existe en el
código anterior.

Trampas verificadas de este repo, que ya costaron incidentes:

- `hosting:rollback` **no existe** en firebase-tools (ni 13.35.1 ni 15.23.0). El comando real
  es `hosting:clone <site>@<versionId> <site>:live`, y tiene dos falsos positivos conocidos:
  `--project` es inerte y un typo de canal crea un canal preview con EXIT 0 dejando live intacto.
- `gcloud` no está instalado en la máquina del owner: pausar y reanudar schedulers va por REST.
- Un rollback de functions no frena los schedulers; se pausan aparte.
- `--only functions` sin selector crea funciones de desarrollo en producción.
