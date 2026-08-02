import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/markdown.ts',
    'src/verify.ts',
    'src/pay.ts',
    'src/firewall.ts',
    'src/adapters/posthog.ts',
    'src/adapters/webhook.ts'
  ],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  splitting: false,
  treeshake: true,
  minify: true
})
