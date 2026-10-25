import { defineConfig } from 'vitest/config';
import base from './vitest.config.ts';

// The Ask eval (eval/ask.eval.ts, docs/ask-eval.md): `npm run eval:ask`. Kept out of `npm test`
// because a live run calls the Anthropic API; its unit tests (eval/*.test.ts) run with the rest.
// Same plugins and settings as the unit tests, with only the eval included.
export default defineConfig({
  ...base,
  test: { ...base.test, include: ['eval/**/*.eval.ts'], silent: false },
});
