import { test, expect } from '../support/fixtures';

test.describe('first-run onboarding', () => {
  test('picking a level builds a starter deck from the catalog', async ({ authedPage: page, backend }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/welcome/);

    await page.getByRole('button', { name: /Pick a level/ }).click();
    await page.getByRole('radio', { name: /HSK 2/ }).click();
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('heading', { name: "You're all set" })).toBeVisible();
    await expect(page.getByText(/Your deck starts with\s*30 words/)).toBeVisible();

    // What the UI reported is what the server stored.
    const status = await backend.get<{ onboarded: boolean; declared_hsk_level: number; has_cards: boolean }>(
      '/onboarding/status',
    );
    expect(status).toMatchObject({ onboarded: true, declared_hsk_level: 2, has_cards: true });

    await page.getByRole('button', { name: 'Study your first cards' }).click();
    await expect(page).toHaveURL(/\/session\/start$/);
  });

  test('the placement check infers a level from the ticked words', async ({ authedPage: page, backend }) => {
    await page.goto('/welcome');
    await page.getByRole('button', { name: /Take a 2-minute check/ }).click();

    const words = page.locator('button[aria-pressed]');
    await expect(words.first()).toBeVisible();
    const total = await words.count();
    expect(total).toBeGreaterThan(10);

    // Tick the first third — the sample is ordered by band, easiest first.
    const tick = Math.floor(total / 3);
    for (let i = 0; i < tick; i++) await words.nth(i).click();
    await expect(page.getByText(`${tick} / ${total}`)).toBeVisible();

    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('heading', { name: "You're all set" })).toBeVisible();

    const status = await backend.get<{ onboarded: boolean; declared_hsk_level: number; known_word_count: number }>(
      '/onboarding/status',
    );
    expect(status.onboarded).toBe(true);
    expect(status.declared_hsk_level).toBeGreaterThanOrEqual(1);
    expect(status.known_word_count).toBeGreaterThanOrEqual(tick);
  });

  test('an onboarded account is never sent back to /welcome', async ({ authedPage: page, backend }) => {
    await backend.onboard();
    await page.goto('/welcome');
    await expect(page).toHaveURL(/\/$/);
  });
});
