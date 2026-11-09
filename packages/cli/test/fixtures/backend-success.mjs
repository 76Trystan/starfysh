// Minimal backend that treats every replay as a successful run against a
// stub Page. No outputs are emitted, so the stability report is trivially
// stable (empty outputs on every run).

function stubLocator() {
  return {
    click: async () => {},
    fill: async () => {},
    isVisible: async () => true,
    locator: () => stubLocator(),
    count: async () => 1,
    nth: () => stubLocator(),
    allTextContents: async () => [],
    all: async () => [],
  };
}

function stubPage() {
  return {
    goto: async () => {},
    url: () => 'https://example.com/',
    locator: () => stubLocator(),
    getByRole: () => stubLocator(),
    getByTestId: () => stubLocator(),
    getByText: () => stubLocator(),
    getByLabel: () => stubLocator(),
    waitForTimeout: async () => {},
  };
}

export const pageFactory = () => stubPage();
export const runner = async () => {};
