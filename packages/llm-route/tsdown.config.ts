import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  dts: true,
  target: 'node20',
  platform: 'node',
  // pi-ai 树由 dsh 宿主提供;打进 bundle 反而会双实例
  external: [/^@deepseek-ai\//],
})
