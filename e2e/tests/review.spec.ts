import type { Page } from '@playwright/test';
import { test, expect } from '../support/fixtures';

type Stats = {
  total_reviews: number;
  streak_days: number;
  total_cards: number;
  reviews_today: number;
  daily_review_goal: number;
  recent_days: { date: string; count: number; goal_met: boolean }[];
};

async function startReview(page: Page) {
  await page.goto('/session/start');
  await page.getByRole('button', { name: 'Start review' }).click();
  await expect(page).toHaveURL(/\/session$/);
  // The bar renders "of 0" until the cards arrive.
  await expect(page.getByRole('progressbar', { name: /^Card 1 of [1-9]\d*$/ })).toBeVisible();
}

/** "Card 3 of 10" → [3, 10] */
async function progress(page: Page): Promise<[number, number]> {
  const label = await page.getByRole('progressbar', { name: /^Card \d+ of \d+$/ }).getAttribute('aria-label');
  const [, at, of] = label!.match(/Card (\d+) of (\d+)/)!;
  return [Number(at), Number(of)];
}

test.describe('flashcard review', () => {
  test.beforeEach(async ({ backend }) => {
    await backend.onboard(1, 30);
  });

  test('a full session is graded, persisted and summarised', async ({ authedPage: page, backend }) => {
    await startReview(page);
    const [, total] = await progress(page);
    expect(total).toBeGreaterThan(0);

    for (let i = 1; i <= total; i++) {
      await expect(page.getByRole('progressbar', { name: `Card ${i} of ${total}` })).toBeVisible();
      await page.getByRole('button', { name: /Show answer/ }).click();
      await page.getByRole('button', { name: 'Good: Recalled' }).click();
    }

    await expect(page).toHaveURL(/\/complete$/);
    await expect(page.getByText(`${total} of ${total} recalled`)).toBeVisible();

    await expect.poll(async () => (await backend.get<Stats>('/stats')).total_reviews).toBe(total);
    expect((await backend.get<Stats>('/stats')).streak_days).toBe(0);
  });

  test('a bounded session completes the daily goal and updates the dashboard', async ({ authedPage: page, backend }) => {
    await backend.send('PATCH', '/settings?session_size=5&daily_review_goal=5');
    await startReview(page);
    const [, total] = await progress(page);
    expect(total).toBe(5);

    for (let i = 1; i <= total; i++) {
      await page.getByRole('button', { name: /Show answer/ }).click();
      await page.getByRole('button', { name: 'Good: Recalled' }).click();
    }

    await expect(page).toHaveURL(/\/complete$/);
    await expect(page.getByText('Daily goal reached · 5 reviews today')).toBeVisible();
    await expect.poll(async () => (await backend.get<Stats>('/stats')).reviews_today).toBe(5);
    const stats = await backend.get<Stats>('/stats');
    expect(stats.streak_days).toBe(1);
    expect(stats.recent_days.at(-1)).toMatchObject({ count: 5, goal_met: true });

    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByText('5 / 5', { exact: true })).toBeVisible();
    await expect(page.getByText('Daily goal reached. Show up again tomorrow.')).toBeVisible();
  });

  test('concurrent reviews by one user all count', async ({ backend }) => {
    // A fast reviewer has several POST /review in flight at once; the profile
    // counters used to lose increments to each other.
    const { cards } = await backend.get<{ cards: { card_id: number }[] }>('/session');
    expect(cards.length).toBeGreaterThanOrEqual(8);
    await Promise.all(cards.map((c) => backend.send('POST', `/review/${c.card_id}`, { rating: 3 })));
    expect((await backend.get<Stats>('/stats')).total_reviews).toBe(cards.length);
  });

  test('keyboard: space reveals, number keys rate', async ({ authedPage: page, backend }) => {
    await startReview(page);
    await expect(page.getByRole('button', { name: /Show answer/ })).toBeVisible();

    await page.keyboard.press('Space');
    await expect(page.getByRole('group', { name: 'How well did you remember it?' })).toBeVisible();
    await page.keyboard.press('3');

    await expect(page.getByRole('progressbar', { name: /^Card 2 of/ })).toBeVisible();
    await expect.poll(async () => (await backend.get<Stats>('/stats')).total_reviews).toBe(1);
  });

  test('word audio is synthesised, stored and served', async ({ authedPage: page }) => {
    await startReview(page);
    await page.getByRole('button', { name: /Show answer/ }).click();

    const audio = page.waitForResponse(
      (r) => /\/(words\/\d+\/audio\/hanzi|storage\/v1\/object\/public\/word-audio\/)/.test(r.url()) && r.status() === 200,
    );
    await page.getByRole('button', { name: 'Play word' }).click();
    const res = await audio;
    expect(res.headers()['content-type']).toContain('audio/');
  });

  test('ratings made offline are queued and replayed on reconnect', async ({ authedPage: page, backend, context }) => {
    await startReview(page);
    const [, total] = await progress(page);
    expect(total).toBeGreaterThanOrEqual(3);

    // The session's cards are already loaded; drop the network for two ratings.
    await context.setOffline(true);
    for (let i = 1; i <= 2; i++) {
      await page.getByRole('button', { name: /Show answer/ }).click();
      await page.getByRole('button', { name: 'Good: Recalled' }).click();
      await expect(page.getByRole('progressbar', { name: `Card ${i + 1} of ${total}` })).toBeVisible();
    }
    expect((await backend.get<Stats>('/stats')).total_reviews).toBe(0);

    await context.setOffline(false);
    await expect.poll(async () => (await backend.get<Stats>('/stats')).total_reviews, { timeout: 15_000 }).toBe(2);
  });
});
