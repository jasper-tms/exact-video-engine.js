// Shared launcher for the test drivers.
//
// Two knobs, both environment variables so run-tests.sh (and a second checkout
// running its suite at the same time) can set them without touching the tests:
//
//   TEST_BROWSER  chromium (default) | webkit | firefox. WebKit here is the
//                 same engine as Safari and every iOS browser, so running the
//                 correctness tests under it is the closest thing to a phone
//                 that fits in continuous integration.
//   TEST_PORT     where test/serve.py is listening (default 8798).
import { chromium, webkit, firefox } from 'playwright';

export const browserName = process.env.TEST_BROWSER || 'chromium';
export const serverBase = `http://localhost:${process.env.TEST_PORT || 8798}`;

export function launchBrowser() {
  const browserType = { chromium, webkit, firefox }[browserName];
  if (!browserType) {
    throw new Error(`unknown TEST_BROWSER '${browserName}' `
      + `(expected chromium, webkit, or firefox)`);
  }
  return browserType.launch();
}
