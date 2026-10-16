// The redesigned frontend checked against flashcard-frontend/design-standards.md,
// on the real stack, on both projects (desktop 1280 and Pixel 7 touch).
// Section numbers (§n) refer to that document.
import type { Page } from '@playwright/test';
import { test as base, expect, type Backend, type Llm } from '../support/fixtures';
import {
  axeAudit, chineseWithoutLang, cls, focusProblems, h1Count, horizontalOverflow,
  loudCopy, smallInputs, smallTargets, tinyText, visibleKbdHints,
} from '../support/audit';

// ── Seeded learner: onboarded with a deck, one reviewed card and one story ──

type Learner = { wordId: number; textId: number };

const story = {
  title: '我的朋友',
  hanzi: '我有一个朋友。他是学生。我们很好。\n\n今天我们去学校。',
  english_translation: 'I have a friend. He is a student. We are fine. Today we go to school.',
  topic: 'a friend', genre: 'story', new_words_used: [], recycled_words_used: [],
};

async function seedLearner(backend: Backend, llm: Llm, tag: string): Promise<Learner> {
  await backend.onboard(1, 30);
  const { cards } = await backend.get<{ cards: { card_id: number }[] }>('/session');
  await backend.send('POST', `/review/${cards[0]!.card_id}`, { rating: 3 });

  const topic = `standards-${tag}`;
  await llm.reply(JSON.stringify(story), { match: topic });
  const res = await backend.http.post('/ci/texts', { data: { topic } });
  expect(res.ok()).toBeTruthy();
  const done = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === 'done');
  expect(done, 'story generation finished').toBeTruthy();

  const words = await backend.get<{ items: { word_id: number }[] }>('/words?page=1');
  return { wordId: words.items[0]!.word_id, textId: done.text.id };
}

const test = base.extend<{ learner: Learner }>({
  learner: async ({ backend, llm }, use, info) => { await use(await seedLearner(backend, llm, info.testId)); },
});

/** Rate every card Good until the completion screen. Waits for each card to
 *  render instead of probing, so it can't race the next card's swap-in. */
async function rateToCompletion(page: Page) {
  const reveal = page.getByRole('button', { name: /Show answer/ });
  const done = page.getByText('Session complete');
  for (let i = 0; i < 80; i++) {
    await expect(reveal.or(done)).toBeVisible();
    if (await done.isVisible()) return;
    await reveal.click();
    await page.getByRole('button', { name: 'Good: Recalled' }).click();
  }
  throw new Error('session did not complete within 80 cards');
}

/** Wait until the view has data: no skeletons or busy regions left. */
async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
}

type Route = { name: string; path: (l: Learner) => string; ready: (p: Page) => Promise<void> };
const h = (name: RegExp | string) => async (p: Page) => { await expect(p.getByRole('heading', { level: 1, name })).toBeVisible(); };

const routes: Route[] = [
  { name: 'today', path: () => '/', ready: h(/Good|Studying/) },
  { name: 'study', path: () => '/session/start', ready: h('Study') },
  { name: 'session', path: () => '/session', ready: async (p) => { await expect(p.getByRole('button', { name: /Show answer/ })).toBeVisible(); } },
  { name: 'words', path: () => '/browse', ready: h('Your words') },
  { name: 'word detail', path: (l) => `/words/${l.wordId}`, ready: async (p) => { await expect(p.getByRole('heading', { level: 1 })).toBeVisible(); } },
  { name: 'add word', path: () => '/add', ready: h('Add a word') },
  { name: 'teacher', path: () => '/generate', ready: h('What would you like to learn?') },
  { name: 'typing', path: () => '/typing', ready: h('Pinyin typing') },
  { name: 'read', path: () => '/read', ready: h('Read') },
  { name: 'reader', path: (l) => `/read/${l.textId}`, ready: h(story.title) },
  { name: 'speaking', path: () => '/hskk', ready: h('HSKK speaking test') },
  { name: 'speaking history', path: () => '/hskk/history', ready: h('Exam history') },
  { name: 'settings', path: () => '/settings', ready: h('Settings') },
];

/** Every route-level rule, soft-asserted so one run lists every breach. */
async function auditRoute(page: Page, isMobile: boolean) {
  const axe = await axeAudit(page);
  expect.soft(axe.blocking, '§3 axe: serious/critical WCAG 2.2 AA violations').toEqual([]);
  if (axe.other.length) test.info().annotations.push({ type: 'axe (moderate/minor)', description: axe.other.join('\n') });

  expect.soft(await h1Count(page), '§3 exactly one h1').toBe(1);
  expect.soft(await horizontalOverflow(page), '§2 no horizontal scroll').toBeLessThanOrEqual(0);
  expect.soft(await smallTargets(page, isMobile ? 44 : 36), `§3 targets ≥ ${isMobile ? 44 : 36}px`).toEqual([]);
  expect.soft(await tinyText(page), '§5 no text under 12px').toEqual([]);
  expect.soft(await chineseWithoutLang(page), '§3 Chinese text carries lang="zh-CN"').toEqual([]);
  expect.soft(await loudCopy(page), '§11 no exclamation marks or emoji').toEqual([]);
  expect.soft(await smallInputs(page), '§2 inputs ≥ 16px (no iOS zoom)').toEqual([]);
  if (isMobile) expect.soft(await visibleKbdHints(page), '§2 no keyboard hints on touch').toBe(0);
  expect.soft(await focusProblems(page), '§3 focus visible and not obscured').toEqual([]);
}

test.describe('§2–§11 every route meets the standards', () => {
  for (const r of routes) {
    test(r.name, async ({ authedPage: page, learner, isMobile }) => {
      await page.goto(r.path(learner));
      await r.ready(page);
      await settle(page);
      await auditRoute(page, !!isMobile);
    });
  }

  test('login', async ({ page, isMobile }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { level: 1, name: 'Welcome back' })).toBeVisible();
    await settle(page);
    await auditRoute(page, !!isMobile);
  });

  test('welcome, every step', async ({ authedPage: page, isMobile }) => {
    test.setTimeout(90_000);
    await page.goto('/welcome');
    await expect(page.getByRole('heading', { level: 1, name: "Let's find your level" })).toBeVisible();
    await settle(page);
    await auditRoute(page, !!isMobile);

    await page.getByRole('button', { name: /Pick a level/ }).click();
    await page.getByRole('radio', { name: /HSK 2/ }).click();
    await auditRoute(page, !!isMobile);

    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { level: 1, name: "You're all set" })).toBeVisible();
    await settle(page);
    await auditRoute(page, !!isMobile);
  });

  test('typing practice, feedback and summary', async ({ authedPage: page, learner: _, isMobile }) => {
    test.setTimeout(120_000);
    await page.goto('/typing');
    await page.getByRole('radio', { name: '5 words' }).click();
    await page.getByRole('button', { name: 'Start practice' }).click();
    const input = page.getByLabel('Type the pinyin');
    await expect(input).toBeVisible();
    await settle(page);
    await auditRoute(page, !!isMobile);

    for (let i = 0; i < 10; i++) {
      await input.fill('ma1');
      await page.getByRole('button', { name: 'Check' }).click();
      await page.getByRole('button', { name: 'Pick the characters' }).click();
      await page.getByRole('group', { name: 'Pick the characters' }).getByRole('button').first().click();
      if (i === 0) await auditRoute(page, !!isMobile);
      const next = page.getByRole('button', { name: /^(Next word|Finish)\b/ });
      const last = (await next.textContent())?.includes('Finish');
      await next.click();
      if (last) break;
      await expect(input).toBeVisible();
    }
    await expect(page.getByText('Practice complete')).toBeVisible();
    await settle(page);
    await auditRoute(page, !!isMobile);
  });

  test('session answer side and completion', async ({ authedPage: page, learner: _, isMobile }) => {
    test.setTimeout(120_000);
    await page.goto('/session');
    await page.getByRole('button', { name: /Show answer/ }).click();
    await expect(page.getByRole('group', { name: 'How well did you remember it?' })).toBeVisible();
    await settle(page);
    await auditRoute(page, !!isMobile);

    // Rate through to the completion screen and audit that too.
    await page.getByRole('button', { name: 'Good: Recalled' }).click();
    await rateToCompletion(page);
    await expect(page).toHaveURL(/\/complete$/);
    await settle(page);
    await auditRoute(page, !!isMobile);
  });
});

test.describe('§1/§2 app shell and navigation', () => {
  const tabs = ['Today', 'Study', 'Read', 'Words', 'Me'];

  test('five primary destinations, current one marked, reachable from every tab', async ({ authedPage: page, learner: _ }) => {
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Primary' });
    for (const t of tabs) await expect(nav.getByRole('link', { name: new RegExp(`^${t}`) })).toBeVisible();
    for (const [t, url] of [['Study', /\/session\/start$/], ['Read', /\/read$/], ['Words', /\/browse$/], ['Me', /\/settings$/], ['Today', /\/$/]] as const) {
      await nav.getByRole('link', { name: new RegExp(`^${t}`) }).click();
      await expect(page).toHaveURL(url);
      await expect(nav.getByRole('link', { name: new RegExp(`^${t}`) })).toHaveAttribute('aria-current', 'page');
    }
  });

  test('placement: bottom bar on phones, rail at 768, labelled sidebar on desktop', async ({ authedPage: page, learner: _, isMobile }) => {
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'Primary' });
    const vp = page.viewportSize()!;
    if (isMobile) {
      const box = (await nav.boundingBox())!;
      expect(Math.round(box.y + box.height)).toBe(vp.height);
      expect(box.width).toBe(vp.width);
    } else {
      let box = (await nav.boundingBox())!;
      expect(box.x).toBe(0);
      expect(box.width).toBeGreaterThan(200); // sidebar with labels
      await expect(nav.getByText('今天')).toBeVisible();
      await page.setViewportSize({ width: 768, height: 1024 });
      box = (await nav.boundingBox())!;
      expect(box.x).toBe(0);
      expect(box.width).toBeLessThan(120); // icon rail
      await expect(nav.getByText('今天')).toBeHidden();
    }
  });

  test('the first card is at most two taps from launch', async ({ authedPage: page, learner: _ }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Learn new cards|Start review|Start studying/ }).click();
    await expect(page.getByRole('button', { name: /Show answer/ })).toBeVisible();
  });

  test('focus mode hides navigation; leaving restores it', async ({ authedPage: page, learner }) => {
    const nav = page.getByRole('navigation', { name: 'Primary' });
    for (const path of ['/session', `/read/${learner.textId}`]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 }).or(page.getByRole('button', { name: /Show answer/ })).first()).toBeVisible();
      await expect(nav).toHaveCount(0);
    }
    // Typing: setup keeps the nav, practice hides it, leaving brings it back.
    await page.goto('/typing');
    await expect(nav).toBeVisible();
    await page.getByRole('button', { name: 'Start practice' }).click();
    await expect(page.getByLabel('Type the pinyin')).toBeVisible();
    await expect(nav).toHaveCount(0);
    await page.getByRole('button', { name: /End practice/ }).click();
    await expect(nav).toBeVisible();
  });

  test('bare screens (login, welcome) have no navigation', async ({ page, account }) => {
    await page.goto('/login');
    await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password', { exact: true }).fill(account.password);
    await page.locator('form').getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/welcome/);
    await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
  });

  test('back returns where you came from, with the list scroll restored', async ({ authedPage: page, learner: _ }) => {
    await page.goto('/browse');
    await expect(page.getByRole('heading', { level: 1, name: 'Your words' })).toBeVisible();
    await settle(page);
    await page.evaluate(() => window.scrollTo(0, 600));
    // A row inside the viewport, so clicking it doesn't scroll the list first.
    const link = page.locator('main a[href^="/words/"]').nth(8);
    await link.hover();
    const before = await page.evaluate(() => scrollY);
    expect(before).toBeGreaterThan(200);
    await link.click();
    await expect(page).toHaveURL(/\/words\/\d+$/);
    await page.getByRole('button', { name: 'Back to your words' }).click();
    await expect(page).toHaveURL(/\/browse$/);
    await expect.poll(() => page.evaluate(() => scrollY)).toBe(before);
  });

  test('the tab bar never covers the end of a page', async ({ authedPage: page, learner: _, isMobile }) => {
    test.skip(!isMobile, 'tab bar is a phone layout');
    await page.goto('/settings');
    await settle(page);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const navTop = (await page.getByRole('navigation', { name: 'Primary' }).boundingBox())!.y;
    const lastBottom = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('main *')).filter((e) => e.getBoundingClientRect().height > 0);
      return Math.max(...els.map((e) => e.getBoundingClientRect().bottom));
    });
    expect(lastBottom).toBeLessThanOrEqual(navTop + 1);
  });

  test('§3 reflow: no horizontal scroll at 320px on any route', async ({ authedPage: page, learner }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 320, height: 640 });
    const offenders: string[] = [];
    for (const r of routes) {
      await page.goto(r.path(learner));
      await r.ready(page);
      await settle(page);
      const o = await horizontalOverflow(page);
      if (o > 0) offenders.push(`${r.name}: +${o}px`);
    }
    expect(offenders).toEqual([]);
  });
});

test.describe('§4/§13 theme', () => {
  const bg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const themeColor = (page: Page) => page.evaluate(() => {
    const metas = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
    const active = metas.find((m) => !m.media || matchMedia(m.media).matches);
    return active?.content.toUpperCase();
  });

  test('follows the system by default: paper in light, aubergine in dark', async ({ authedPage: page, learner: _ }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.hasAttribute('data-theme'))).toBe(false);
    expect(await bg(page)).toBe('rgb(251, 248, 245)');
    expect(await themeColor(page)).toBe('#FBF8F5');

    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => bg(page)).toBe('rgb(27, 16, 53)');
    await expect.poll(() => themeColor(page)).toBe('#1B1035');
  });

  test('an explicit choice in Settings overrides the system and persists', async ({ authedPage: page, learner: _ }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/settings');
    await page.getByRole('radio', { name: 'Dark' }).click();
    await expect.poll(() => bg(page)).toBe('rgb(27, 16, 53)');
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark');
    expect(await bg(page)).toBe('rgb(27, 16, 53)');

    await page.getByRole('radio', { name: 'System' }).click();
    await expect.poll(() => bg(page)).toBe('rgb(251, 248, 245)');
    expect(await page.evaluate(() => document.documentElement.hasAttribute('data-theme'))).toBe(false);
  });

  test('every route also passes axe in the dark theme', async ({ authedPage: page, learner }) => {
    test.setTimeout(180_000);
    await page.emulateMedia({ colorScheme: 'dark' });
    const failures: string[] = [];
    for (const r of routes) {
      await page.goto(r.path(learner));
      await r.ready(page);
      await settle(page);
      const { blocking } = await axeAudit(page);
      failures.push(...blocking.map((b) => `${r.name}: ${b}`));
    }
    expect(failures).toEqual([]);
  });
});

test.describe('§5 typography', () => {
  test('UI in IBM Plex, study hanzi in Kai, display in Michroma', async ({ authedPage: page, learner }) => {
    const family = (sel: string) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).fontFamily);
    await page.goto('/session');
    await page.getByRole('button', { name: /Show answer/ }).click(); // either side has hanzi once revealed
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(/^"?IBM Plex Sans/);
    expect(await family('main [lang="zh-CN"] .ruby-hanzi, main [lang="zh-CN"] .hanzi')).toMatch(/LXGW WenKai/);

    await page.goto(`/read/${learner.textId}`);
    await expect(page.getByRole('heading', { level: 1, name: story.title })).toBeVisible();
    expect(await family('article .para')).toMatch(/LXGW WenKai/);

    // The fonts actually load (not just declared).
    await page.evaluate(() => document.fonts.ready);
    const loaded = await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, '')));
    expect(loaded).toEqual(expect.arrayContaining(['IBM Plex Sans Variable', 'LXGW WenKai Screen']));
  });

  test('reading text never starts a line with closing punctuation', async ({ authedPage: page, learner }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(`/read/${learner.textId}`);
    await expect(page.getByRole('heading', { level: 1, name: story.title })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const bad = await page.evaluate(() => {
      const closing = /^[。，、；：？！」』）》〉】”’]/;
      const out: string[] = [];
      for (const para of Array.from(document.querySelectorAll('article .para'))) {
        const left = para.getBoundingClientRect().left;
        const indent = parseFloat(getComputedStyle(para).textIndent) || 0;
        const range = document.createRange();
        const walker = document.createTreeWalker(para, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const t = n.textContent ?? '';
          for (let i = 0; i < t.length; i++) {
            range.setStart(n, i); range.setEnd(n, i + 1);
            const r = range.getBoundingClientRect();
            // A glyph flush with the paragraph's left edge starts a line (the first line is indented).
            if (Math.abs(r.left - left) < 2 && closing.test(t[i]!)) out.push(t.slice(i, i + 6));
          }
        }
        void indent;
      }
      return out;
    });
    expect(bad).toEqual([]);
  });
});

test.describe('§9 states', () => {
  test('error: inline message with a working Retry', async ({ authedPage: page, learner: _ }) => {
    let fail = true;
    await page.route('**/api/stats', (route) => (fail ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x","message":"Stats are unavailable"}' }) : route.fallback()));
    await page.goto('/');
    const banner = page.getByRole('alert').filter({ hasText: "Couldn't load your stats" });
    await expect(banner).toBeVisible();
    fail = false;
    await banner.getByRole('button', { name: 'Retry' }).click();
    await expect(banner).toBeHidden();
    await expect(page.getByRole('heading', { name: /cards due|Your deck is ready|All caught up/ })).toBeVisible();
  });

  test('loading: skeletons are announced as busy, then replaced', async ({ authedPage: page, learner: _ }) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    await page.route('**/api/words?**', async (route) => { await gate; await route.fallback(); });
    await page.goto('/browse');
    await expect(page.locator('[aria-busy="true"]').first()).toBeVisible();
    release();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await expect(page.locator('main a[href^="/words/"]').first()).toBeVisible();
  });

  test('empty: a search with no matches explains itself and offers a way out', async ({ authedPage: page, learner: _ }) => {
    await page.goto('/browse');
    await page.getByRole('searchbox', { name: 'Search your words' }).fill('zzzz-no-such-word');
    await expect(page.getByRole('heading', { name: 'No words match' })).toBeVisible();
    await page.getByRole('button', { name: 'Clear search and filter' }).click();
    await expect(page.locator('main a[href^="/words/"]').first()).toBeVisible();
  });

  test('empty: a new reader library invites the first story', async ({ authedPage: page, backend }) => {
    await backend.onboard(1, 10);
    await page.goto('/read');
    await expect(page.getByRole('heading', { name: 'Your first story is one tap away' })).toBeVisible();
  });

  test('offline: Study says so and disables what needs the network', async ({ authedPage: page, learner: _, context }) => {
    await page.goto('/session/start');
    await expect(page.getByRole('heading', { level: 1, name: 'Study' })).toBeVisible();
    await settle(page);
    await context.setOffline(true);
    await expect(page.getByText(/You.re offline/)).toBeVisible();
    await expect(page.getByRole('button', { name: /^Download/ })).toBeDisabled();
    await context.setOffline(false);
  });

  test('forms validate on blur and submit, keep input, and never block silently', async ({ authedPage: page, learner: _ }) => {
    await page.goto('/add');
    await page.getByLabel('Meaning').fill('to persist');
    await page.getByRole('button', { name: 'Save word' }).click();
    await expect(page.getByText('Hanzi is required')).toBeVisible();
    await expect(page.getByText('Pinyin is required')).toBeVisible();
    await expect(page.getByLabel('Meaning')).toHaveValue('to persist');
    await expect(page.getByLabel('Hanzi')).toHaveAttribute('aria-invalid', 'true');
  });
});

test.describe('§3/§10 motion and celebration', () => {
  async function finishSession(page: Page) {
    await page.goto('/session');
    await rateToCompletion(page);
    await expect(page).toHaveURL(/\/complete$/);
  }

  test('session complete celebrates with the signal rule, calmly', async ({ authedPage: page, learner: _ }) => {
    test.setTimeout(90_000);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await finishSession(page);
    await expect(page.getByText('Session complete')).toBeVisible();
    const anim = await page.locator('.rule__bar').evaluate((el) => getComputedStyle(el).animationName);
    expect(anim).toMatch(/^rule-draw/); // Vue scopes keyframe names (rule-draw-<hash>)
  });

  test('reduced motion: no celebration animation, no long transitions', async ({ authedPage: page, learner: _ }) => {
    test.setTimeout(90_000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await finishSession(page);
    const anim = await page.locator('.rule__bar').evaluate((el) => {
      const cs = getComputedStyle(el);
      return { name: cs.animationName, dur: parseFloat(cs.animationDuration) };
    });
    expect(anim.name === 'none' || anim.dur <= 0.001).toBe(true);
    const slow = await page.evaluate(() => Array.from(document.querySelectorAll('*'))
      .map((el) => getComputedStyle(el).transitionDuration.split(',').map(parseFloat))
      .flat().filter((d) => d > 0.15).length);
    expect(slow).toBe(0);
  });
});

test.describe('§12 performance (dev server, so only layout stability and responsiveness)', () => {
  test('no layout shift while Today and the session load', async ({ authedPage: page, learner: _ }) => {
    await page.goto('/');
    await settle(page);
    expect(await cls(page)).toBeLessThanOrEqual(0.1);
    await page.goto('/session');
    await expect(page.getByRole('button', { name: /Show answer/ })).toBeVisible();
    await settle(page);
    expect(await cls(page)).toBeLessThanOrEqual(0.1);
  });

  test('reveal and rate respond within 100 ms', async ({ authedPage: page, learner: _ }) => {
    await page.goto('/session');
    await expect(page.getByRole('button', { name: /Show answer/ })).toBeVisible();
    const t = await page.evaluate(async () => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => /Show answer/.test(b.textContent ?? ''))!;
      const t0 = performance.now();
      btn.click();
      await new Promise<void>((resolve) => {
        const check = () => (document.querySelector('[role="group"][aria-label="How well did you remember it?"]') ? resolve() : requestAnimationFrame(check));
        check();
      });
      const t1 = performance.now();
      const good = document.querySelector<HTMLButtonElement>('button[aria-label="Good: Recalled"]')!;
      const label = document.querySelector('[role="progressbar"]')?.getAttribute('aria-label');
      good.click();
      await new Promise<void>((resolve) => {
        const check = () => (document.querySelector('[role="progressbar"]')?.getAttribute('aria-label') !== label ? resolve() : requestAnimationFrame(check));
        check();
      });
      return { reveal: t1 - t0, rate: performance.now() - t1 };
    });
    expect(t.reveal).toBeLessThan(100);
    expect(t.rate).toBeLessThan(100);
  });
});
