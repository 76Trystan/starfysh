# @sfysh/parser

## 0.1.0

### Minor Changes

- 33f0555: Initial public release. `@sfysh/parser` lifts hand-written Playwright TypeScript scripts into the Starfysh IR so existing scripts can be verified and healed by the Starfysh toolchain. Covers `page.goto`, `fill`, `click`, `waitFor*`, ranked selector extraction from `getByRole` / `getByTestId` / `getByText` / `getByLabel` / CSS locators, and condition inference from `expect().toBeVisible()`, `.toHaveURL()`, `.toHaveText()`, and related matchers.
