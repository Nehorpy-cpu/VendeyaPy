import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/__tests__/**/*.test.ts'],
    // Env determinístico para tests (vale local y en CI limpio). Son valores DUMMY:
    // satisfacen el ConfigSchema (getConfig) sin secretos reales.
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      N8N_BASE_URL: 'http://localhost:5678',
      N8N_INTERNAL_SECRET: 'test-n8n-internal-secret-0000000000000000',
      WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'test-verify-token',
      WHATSAPP_APP_SECRET: 'test-app-secret',
      TENANT_SECRETS_ENCRYPTION_KEY: 'test-tenant-encryption-key-000000000000000',
      API_BASE_URL: 'http://localhost:5001',
      WEB_BASE_URL: 'http://localhost:3000',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/__tests__/**', 'src/index.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
