// Test fixtures. Every test gets its own freshly created account, so tests
// are isolated without resetting the database and can run in parallel; the
// HSK catalog is shared and read-only.
import { test as base, expect, request, type APIRequestContext, type Page } from '@playwright/test';
import { API_URL, AUTH_STORAGE_KEY, ports } from './env';

const STUB = `http://127.0.0.1:${ports.stub}`;

export interface Account {
  email: string;
  password: string;
  /** Supabase user id (the JWT `sub`). */
  uid: string;
  accessToken: string;
  /** The raw session object supabase-js keeps in localStorage. */
  session: Record<string, unknown>;
}

/** Backend calls made as the test's account, for arranging state and for
 *  asserting what the UI actually persisted. */
export class Backend {
  constructor(readonly http: APIRequestContext) {}

  async get<T = unknown>(path: string): Promise<T> {
    const res = await this.http.get(path);
    expect(res.ok(), `GET ${path} → ${res.status()} ${await res.text()}`).toBeTruthy();
    return res.json() as Promise<T>;
  }

  async send<T = unknown>(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, data?: unknown): Promise<T> {
    const res = await this.http.fetch(path, { method, data });
    expect(res.ok(), `${method} ${path} → ${res.status()} ${await res.text()}`).toBeTruthy();
    return (res.status() === 204 ? undefined : res.json()) as Promise<T>;
  }

  /** Finish onboarding the quick way: declare a level, build the starter deck. */
  async onboard(level = 1, deckSize = 30) {
    await this.send('PATCH', '/onboarding/level', { declared_hsk_level: level });
    return this.send<{ words_added: number }>('POST', '/onboarding/starter-deck', { size: deckSize });
  }
}

/** Scripted DeepSeek replies. The stub answers each completion with the first
 *  queued entry whose `match` occurs in the prompt (or the first entry with no
 *  `match`), then drops it unless `sticky`. The script is global to the stub,
 *  so give entries a `match` that's specific to your test. */
export class Llm {
  constructor(private readonly http: APIRequestContext) {}

  async reply(content: string, opts: { match?: string; sticky?: boolean } = {}) {
    await this.http.post(`${STUB}/__test/llm`, { data: { content, ...opts } });
  }

  async requests(): Promise<{ model: string; messages: { role: string; content: string }[] }[]> {
    return (await (await this.http.get(`${STUB}/__test/llm`)).json()).requests;
  }
}

export async function createAccount(http: APIRequestContext, email?: string): Promise<Account> {
  const res = await http.post(`${STUB}/__test/users`, { data: email ? { email } : {} });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  return {
    email: body.user.email,
    password: body.password,
    uid: body.user.id,
    accessToken: body.session.access_token,
    session: body.session,
  };
}

/** Put the account's session where supabase-js looks for it, before any app
 *  script runs — equivalent to having signed in earlier. */
export async function signInViaStorage(page: Page, account: Account) {
  await page.context().addInitScript(
    ([key, value]) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, value);
    },
    [AUTH_STORAGE_KEY, JSON.stringify(account.session)] as const,
  );
}

type Fixtures = {
  account: Account;
  backend: Backend;
  llm: Llm;
  /** A page already signed in as `account` (not yet navigated). */
  authedPage: Page;
};

export const test = base.extend<Fixtures>({
  account: async ({ playwright }, use) => {
    const http = await playwright.request.newContext();
    await use(await createAccount(http));
    await http.dispose();
  },
  backend: async ({ account }, use) => {
    const http = await request.newContext({
      baseURL: API_URL,
      extraHTTPHeaders: { Authorization: `Bearer ${account.accessToken}` },
    });
    await use(new Backend(http));
    await http.dispose();
  },
  llm: async ({ playwright }, use) => {
    const http = await playwright.request.newContext();
    await use(new Llm(http));
    await http.dispose();
  },
  authedPage: async ({ page, account }, use) => {
    await signInViaStorage(page, account);
    await use(page);
  },
  page: async ({ page }, use) => {
    // Fail loudly on uncaught app errors; they're bugs even when the
    // assertion under test happens to pass.
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await use(page);
    expect(errors, 'uncaught page errors').toEqual([]);
  },
});

export { expect };
