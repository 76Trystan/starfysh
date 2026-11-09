// Backend whose runner emits a different output on each replay, exercising
// the stability-comparison path (drift detected -> non-zero exit code).

import { emit } from '@sfysh/runtime';

let counter = 0;

function stubPage() {
  return {
    goto: async () => {},
    url: () => 'https://example.com/',
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
  counter += 1;
  emit.output({ run: counter });
};
