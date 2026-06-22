/**
 * ai/aiSecret.ts — Secret param de la API key de Anthropic (AI-KEY-1)
 * ==================================================================
 * Firebase Secret Manager. El VALOR vive en Secret Manager (staging/prod) o en `.secret.local`
 * (emulador, gitignored) — NUNCA en el código, los commits, los logs ni `.env.example`. Se bindea
 * SOLO a las Cloud Functions que pueden llegar al AI Gateway (least-privilege): en runtime, Firebase
 * inyecta el valor en `process.env.ANTHROPIC_API_KEY`, que es exactamente lo que lee `getAiClient()`
 * (y el nombre estándar que usa el SDK de Anthropic). En emulador/tests el cliente es el Fake, así que
 * el valor puede faltar sin romper nada (getAiClient → Fake o, sin key en prod, `disabled`).
 */
import { defineSecret } from 'firebase-functions/params';

// Anotación explícita vía ReturnType (evita TS2742: el tipo SecretParam no es nombrable sin
// referenciar el path interno de firebase-functions).
export const ANTHROPIC_API_KEY: ReturnType<typeof defineSecret> = defineSecret('ANTHROPIC_API_KEY');
