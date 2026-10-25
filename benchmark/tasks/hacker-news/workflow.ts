import { workflow, emit } from '@asc/runtime';

workflow('hacker-news-headlines', async (page) => {
  await page.goto('https://news.ycombinator.com', { waitUntil: 'domcontentloaded' });

  const titles = await page.locator('.athing .titleline > a').allTextContents();

  emit.output({ headlines: titles.slice(0, 5).map((t) => t.trim()) });
});
