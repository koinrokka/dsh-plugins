/**
 * 契约测试:patch 直接挂 pi-ai 带 zai-coding-cn 目录路由;依赖钉在与
 * runtime 镜像 dsh 同线(0.1.5-rc.3,semver 预发布 range 陷阱见 versions.yaml)。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

test('cordis patch config-overrides the stock llm-pi-ai entry with the zai route', () => {
  const patch = readFileSync(join(here, '../cordis.patch.yml'), 'utf8')
  assert.match(patch, /- id: llm-pi-ai/)
  assert.doesNotMatch(patch, /insert/, '必须走 id 覆盖;insert 会撞重复条目')
  assert.match(patch, /zai-coding-cn:\s*\{\}/)
})

test('pi-ai dependency is pinned to the dsh line (no prerelease range trap)', () => {
  const pkg = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8'))
  assert.equal(pkg.dependencies['@deepseek-ai/dsh-llm-pi-ai'], '0.1.5-rc.3')
})
