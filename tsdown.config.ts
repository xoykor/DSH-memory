import { defineConfig } from 'tsdown'

/**
 * Self-contained publish build. A git install runs this through `prepare`, so
 * it must not depend on anything outside this package — no project references,
 * no sibling monorepo checkout.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  dts: true,
  clean: true,
  platform: 'node',
})
