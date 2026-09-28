import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  dts: true,
  target: 'node20',
  platform: 'node',
  external: [/^@deepseek-ai\//],
})
