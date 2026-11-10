// Backend whose runner actually calls Page methods, so the recorder has
// something to capture. The returned Page is stubbed but structurally
// implements the Starfysh runtime Page contract.

function stubLocator(overrides = {}) {
  return {
    click: async () => {},
    fill: async () => {},
    isVisible: async () => true,
    locator: () => stubLocator(),
    count: async () => 1,
    nth: () => stubLocator(),
    allTextContents: async () => [],
    all: async () => [],
    ...overrides,
  };
}

function stubPage() {
  return {
    goto: async () => {},
    url: () => 'https://example.com/done',
    locator: () => stubLocator({ isVisible: async () => true }),
    getByRole: () => stubLocator({ isVisible: async () => true }),
    getByTestId: () => stubLocator(),
    getByText: () => stubLocator({ count: async () => 1 }),
    getByLabel: () => stubLocator(),
    waitForTimeout: async () => {},
  };
}

export const pageFactory = () => stubPage();

export const runner = async (ctx) => {
  const { page } = ctx;
  // Hit a representative set of Page methods so the recorder has at least
  // one entry per cassette-value kind.
  page.url();
  await page.locator('#submit').isVisible();
  await page.getByText('Submitted').count();
  await page.locator('#submit').click();
};
