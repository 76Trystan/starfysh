import { workflow } from '@sfysh/runtime';

workflow('books-category', async (ctx) => {
  const { page, emit } = ctx;

  await page.goto('https://books.toscrape.com/catalogue/category/books/travel_2/index.html', {
    waitUntil: 'domcontentloaded',
  });

  const count = await page.locator('article.product_pod').count();

  emit.output({ category: 'travel', count });
});
