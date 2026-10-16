import { test, expect } from '../support/fixtures';

/** A story built only from HSK 1 words, so it clears the known-ratio check
 *  for a fresh HSK 1 account on the first attempt. */
const story = {
  title: '我的朋友',
  hanzi: '我有一个朋友。他是学生。我们很好。\n\n今天我们去学校。',
  english_translation: 'I have a friend. He is a student. We are fine. Today we go to school.',
  topic: 'a friend',
  genre: 'story',
  new_words_used: [],
  recycled_words_used: [],
};

test.describe('reading (comprehensible input)', () => {
  test.beforeEach(async ({ backend }) => {
    await backend.onboard(1, 30);
  });

  test('generate a story, look a word up, rate comprehension', async ({ authedPage: page, llm, backend }, info) => {
    // The stub's script is shared by parallel tests; key this reply to a
    // topic only this test sends.
    const topic = `e2e-topic-${info.testId}`;
    await llm.reply(JSON.stringify(story), { match: topic });

    await page.goto('/read');
    await page.getByRole('button', { name: 'Write me a story' }).first().click();
    await page.getByLabel('Topic').fill(topic);
    await page.getByRole('button', { name: 'Write it' }).click();

    await expect(page).toHaveURL(/\/read\/\d+$/);
    const id = Number(new URL(page.url()).pathname.split('/').pop());
    await expect(page.getByRole('heading', { level: 1, name: story.title })).toBeVisible();
    // Segmented into tappable words by the real jieba + catalog userdict.
    const article = page.getByRole('article');
    await expect(article.getByRole('button', { name: '学生' })).toBeVisible();
    await expect(article.getByRole('button', { name: '学校' })).toBeVisible();

    // The prompt that reached the "LLM" carried the learner's request.
    const sent = (await llm.requests()).filter((r) => r.messages.some((m) => m.content.includes(topic)));
    expect(sent).toHaveLength(1);

    // Look a word up: gloss comes from the catalog.
    await article.getByRole('button', { name: '学校' }).click();
    const word = page.getByRole('dialog', { name: 'Word' });
    await expect(word.getByText('school')).toBeVisible();
    await word.getByRole('button', { name: 'Close' }).click();

    // Audio is synthesised lazily (fake TTS) with per-sentence marks.
    await expect(page.getByRole('region', { name: 'Audio player' }).getByText(/0:00 \/ 0:0[1-9]/)).toBeVisible();

    await page.getByRole('button', { name: "I've finished reading" }).click();
    await page.getByRole('radio', { name: '4 of 5' }).click();
    await page.getByRole('button', { name: 'Save' }).click();

    type Summary = { id: number; comprehension_rating: number | null };
    await expect
      .poll(async () => (await backend.get<Summary[]>('/ci/texts')).find((t) => t.id === id)?.comprehension_rating)
      .toBe(4);
  });

  test('a malformed LLM reply is retried, not shown', async ({ authedPage: page, llm }, info) => {
    const topic = `e2e-retry-${info.testId}`;
    await llm.reply('Sorry, here is your story: not json at all', { match: topic });
    await llm.reply(JSON.stringify({ ...story, title: '重试成功' }), { match: topic });

    await page.goto('/read');
    await page.getByRole('button', { name: 'Write me a story' }).first().click();
    await page.getByLabel('Topic').fill(topic);
    await page.getByRole('button', { name: 'Write it' }).click();

    await expect(page.getByRole('heading', { level: 1, name: '重试成功' })).toBeVisible();
  });
});
