import { workflow, emit } from '@asc/runtime';

workflow('books-detail', async (page) => {
  await page.goto('https://books.toscrape.com/catalogue/a-light-in-the-attic_1000/index.html', {
    waitUntil: 'domcontentloaded',
  });

  const titleArr = await page.locator('.product_main h1').allTextContents();
  const priceArr = await page.locator('.product_main .price_color').allTextContents();
  const availArr = await page.locator('.product_main .instock.availability').allTextContents();

  emit.output({
    title: (titleArr[0] ?? '').trim(),
    price: (priceArr[0] ?? '').trim(),
    availability: (availArr[0] ?? '').trim(),
  });
});
