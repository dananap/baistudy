import { test, expect } from '../support/fixtures';

test.describe('authentication', () => {
  test('signing in with a password lands a new account on first-run onboarding', async ({ page, account }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);

    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password', { exact: true }).fill(account.password);
    await page.locator('form').getByRole('button', { name: 'Sign in' }).click();

    await expect(page).toHaveURL(/\/welcome/);
    await expect(page.getByRole('heading', { name: "Let's find your level" })).toBeVisible();
  });

  test('a wrong password shows an error and stays on the login screen', async ({ page, account }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password', { exact: true }).fill('not-the-password');
    await page.locator('form').getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByText('Incorrect email or password.')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('a deep link survives the login redirect', async ({ page, account, backend }) => {
    await backend.onboard();
    await page.goto('/browse');
    await expect(page).toHaveURL(/\/login\?redirect=(%2F|\/)browse$/);

    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password', { exact: true }).fill(account.password);
    await page.locator('form').getByRole('button', { name: 'Sign in' }).click();

    await expect(page).toHaveURL(/\/browse$/);
  });

  test('creating an account signs the user straight in', async ({ page }) => {
    const email = `signup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
    await page.goto('/login');
    await page.getByRole('radio', { name: 'Create account' }).or(page.getByRole('tab', { name: 'Create account' })).click();
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill('correct-horse-battery');
    await page.locator('form').getByRole('button', { name: 'Create account' }).click();

    await expect(page).toHaveURL(/\/welcome/);
  });
});
