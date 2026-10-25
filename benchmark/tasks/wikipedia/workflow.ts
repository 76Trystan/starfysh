import { workflow, emit } from '@sfysh/runtime';

workflow('wikipedia-web-scraping', async (page) => {
  await page.goto('https://en.wikipedia.org/wiki/Web_scraping', { waitUntil: 'domcontentloaded' });

  const paragraphs = await page.locator('#mw-content-text .mw-parser-output > p').allTextContents();

  const firstParagraph = paragraphs.find((p) => p.trim().length > 0) ?? '';

  emit.output({ firstParagraph: firstParagraph.trim().slice(0, 500) });
});
