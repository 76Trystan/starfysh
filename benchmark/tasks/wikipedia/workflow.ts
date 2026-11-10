import { workflow } from '@sfysh/runtime';

workflow('wikipedia-web-scraping', async (ctx) => {
  const { page, emit } = ctx;

  await page.goto('https://en.wikipedia.org/wiki/Web_scraping', { waitUntil: 'load' });

  const paragraphs = await page.locator('#mw-content-text p').allTextContents();

  const firstParagraph = paragraphs.find((p: string) => p.trim().length > 100) ?? '';

  emit.output({ firstParagraph: firstParagraph.trim().slice(0, 500) });
});
