// Shared pieces for the `compile heal` fixtures: a fake site whose link can
// be renamed, and a model provider that answers from a script. The site
// matches the workflow in test/heal.test.ts (navigate, click the Orders
// link, read the h1).

function timeout(message) {
  const error = new Error(message);
  error.name = 'TimeoutError';
  return error;
}

export function sitePage(site) {
  const locator = (exists, texts = []) => ({
    click: async () => {
      if (!exists) throw timeout('locator.click: Timeout 30000ms exceeded.');
    },
    fill: async () => {},
    isVisible: async () => exists,
    count: async () => (exists ? 1 : 0),
    allTextContents: async () => texts,
    all: async () => [],
    locator: () => locator(false),
    nth: () => locator(exists, texts),
  });
  return {
    goto: async () => {},
    url: () => 'https://portal.example.com/',
    waitForTimeout: async () => {},
    locator: (selector) => locator(selector === 'h1', [site.heading]),
    getByRole: (_role, options) => locator(site.links.includes(options?.name ?? '')),
    getByTestId: () => locator(false),
    getByText: () => locator(false),
    getByLabel: () => locator(false),
    snapshot: async () =>
      [...site.links.map((l) => `- link "${l}"`), `- heading "${site.heading}" [level=1]`].join(
        '\n',
      ),
  };
}

export function scriptedProvider(reply) {
  return {
    name: 'fake',
    model: 'fake-model-2026',
    async complete() {
      return {
        content: reply,
        stopReason: 'end',
        usage: { inputTokens: 1200, outputTokens: 90 },
        model: 'fake-model-2026',
      };
    },
  };
}

export const selectorAnswer = JSON.stringify({
  after: {
    id: 'click_002',
    intent: 'Open the orders page.',
    action: 'click',
    target: { candidates: [{ kind: 'role', value: "link[name='My orders']" }] },
  },
  rationale: 'The link was renamed.',
  confidence: 0.9,
});

export const cannotHeal = JSON.stringify({
  cannotHeal: true,
  rationale: 'Nothing on the page fits.',
});

export const oldSite = { links: ['Orders'], heading: 'Order 1042' };
export const newSite = { links: ['My orders'], heading: 'Order 1042' };
