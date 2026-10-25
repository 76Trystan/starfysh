import { workflow, emit } from '@asc/runtime';

workflow('books-catalogue', async (page) => {
  await page.goto('https://books.toscrape.com', { waitUntil: 'domcontentloaded' });

  const titles = await page.locator('article.product_pod h3 a').allTextContents();
  const prices = await page.locator('article.product_pod .price_color').allTextContents();

  emit.output({
    books: titles.map((title, i) => ({ title: title.trim(), price: (prices[i] ?? '').trim() })),
  });
});
