// Backend whose runner always throws, so every replay fails.

function stubPage() {
  return {
    goto: async () => {},
    url: () => '',
    locator: () => ({}),
    getByRole: () => ({}),
    getByTestId: () => ({}),
    getByText: () => ({}),
    getByLabel: () => ({}),
    waitForTimeout: async () => {},
  };
}

export const pageFactory = () => stubPage();
export const runner = async () => {
  throw new Error('simulated runner failure');
};
