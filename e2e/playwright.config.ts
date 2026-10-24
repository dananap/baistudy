// Full-stack e2e: real frontend (Vite) → real backend (uvicorn) → real
// Postgres, with Supabase Auth/Storage and DeepSeek replaced by the stub in
// stack/stub_server.py and Google TTS/image generation by FAKE_PROVIDERS.
// See README.md.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { ports, STUB_URL } from './support/env';

const root = fileURLToPath(new URL('..', import.meta.url));
const python =
  process.env.E2E_PYTHON ??
  [`${root}flashcard-backend/.venv/bin/python`, `${root}venv/bin/python`].find((p) => existsSync(p)) ??
  'python3';

// No downloaded Playwright browsers on this machine — use system Chromium
// unless told otherwise (PW_USE_BUNDLED=1 after `pnpm exec playwright install`).
const systemChromium = ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => existsSync(p));

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'on-failure' }]],
  use: {
    baseURL: `http://localhost:${ports.web}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Video needs Playwright's ffmpeg (`pnpm exec playwright install ffmpeg`); traces cover most of it.
    video: process.env.E2E_VIDEO ? 'retain-on-failure' : 'off',
    locale: 'en-US',
    timezoneId: 'Europe/Berlin',
    launchOptions: process.env.PW_USE_BUNDLED || !systemChromium ? {} : { executablePath: systemChromium },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel: undefined } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: [
    {
      // Postgres + fresh DB from the catalog template + stub + uvicorn.
      command: `${python} stack/run_stack.py`,
      url: `http://127.0.0.1:${ports.api}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: process.env.E2E_DEBUG ? 'pipe' : 'ignore',
      gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
    },
    {
      command: `pnpm --dir ../flashcard-frontend exec vite --port ${ports.web} --strictPort`,
      url: `http://localhost:${ports.web}`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: process.env.E2E_DEBUG ? 'pipe' : 'ignore',
      // Vite forwards the browser console here; the offline tests make it loud.
      stderr: process.env.E2E_DEBUG ? 'pipe' : 'ignore',
      env: {
        // Explicit values win over flashcard-frontend/.env.local, which
        // points at the production backend and Supabase project.
        VITE_SUPABASE_URL: STUB_URL,
        VITE_SUPABASE_ANON_KEY: 'e2e-anon-key',
        VITE_API_BASE: '/api',
        VITE_ALLOW_SIGNUP: 'true',
        API_PROXY_TARGET: `http://127.0.0.1:${ports.api}`,
        VISUAL_HARNESS: '1', // skips vue-devtools, which injects an overlay
      },
    },
  ],
});
