// Ports and URLs shared by the config and the fixtures. Override with the
// same E2E_* variables stack/run_stack.py reads.
const n = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

export const ports = {
  stub: n('E2E_STUB_PORT', 54340),
  api: n('E2E_API_PORT', 8010),
  web: n('E2E_WEB_PORT', 5180),
};

// `localhost`, not 127.0.0.1: supabase-js derives its storage key from the
// hostname's first label, so this yields `sb-localhost-auth-token`.
export const STUB_URL = `http://localhost:${ports.stub}`;
export const API_URL = `http://127.0.0.1:${ports.api}`;
export const AUTH_STORAGE_KEY = 'sb-localhost-auth-token';
