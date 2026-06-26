/**
 * meta/metaSecrets.ts — Secret param del App Secret de Meta (META-SECRETS-1)
 * =========================================================================
 * Mismo patrón que ai/aiSecret.ts (Firebase Secret Manager). El VALOR vive en Secret Manager
 * (staging/prod) o en `.secret.local` (emulador, gitignored) — NUNCA en el código, los commits,
 * los logs ni `.env.example`. Se bindea SOLO a las Cloud Functions que llaman a la Graph API real
 * (least-privilege): en runtime Firebase inyecta el valor en `process.env.META_APP_SECRET`, que es
 * exactamente lo que lee `meta/graphClient.ts` (HttpMetaGraphClient: exchangeCode / app access token).
 *
 * En emulador/tests NO se usa: getMetaGraphClient() devuelve el FixtureMetaGraphClient (sin red),
 * así que el valor puede faltar sin romper nada (igual que ANTHROPIC con el cliente Fake).
 *
 * Nota: este es el MISMO valor que el "App Secret" de la app de Meta. El webhook lo usa para la firma
 * bajo el nombre WHATSAPP_APP_SECRET (ver docs/meta-go-live.md). META_APP_ID NO es secreto.
 */
import { defineSecret } from 'firebase-functions/params';

// Anotación explícita vía ReturnType (evita TS2742, igual que ai/aiSecret.ts).
export const META_APP_SECRET: ReturnType<typeof defineSecret> = defineSecret('META_APP_SECRET');
