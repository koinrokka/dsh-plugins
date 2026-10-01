/**
 * git-auto 可见性 seam(M4 收尾切片):syncWithReport 把每次 sync 的
 * 成败写入工作区 .koinrokka/git-auto.json,永不抛出;报告目录 git 排除,
 * 不把「每 turn 必脏」带回给自动提交(web 侧读它插 status 消息)。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { syncWithReport } from '../src/index.ts'

const exec = promisify(execFile)

const OPTS = {
  branch: 'koinrokka',
  remote: undefined as string | undefined,
  name: 'koinrokka',
  email: 'koinrokka@locker.local',
}

const readReport = async (root: string): Promise<any> =>
  JSON.parse(await readFile(join(root, '.koinrokka/git-auto.json'), 'utf8'))

test('syncWithReport writes an ok report on success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ga-report-'))
  try {
    await writeFile(join(root, 'hello.py'), 'print("hi")\n')
    const r = await syncWithReport(root, OPTS)
    assert.equal(r.ok, true)
    assert.equal(r.committed, true)

    const file = await readReport(root)
    assert.equal(file.ok, true)
    assert.equal(file.committed, true)
    assert.match(file.at, /^\d{4}-\d{2}-\d{2}T/)
    assert.match(file.subject, /^auto: /)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('syncWithReport writes a failure report and never throws', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ga-report-'))
  try {
    // 非法分支名:git switch -c 必败,注入失败路径
    const r = await syncWithReport(root, { ...OPTS, branch: 'bad..name' })
    assert.equal(r.ok, false)
    assert.ok(r.error)
    assert.match(r.error, /switch|git/)

    const file = await readReport(root)
    assert.equal(file.ok, false)
    assert.equal(typeof file.error, 'string')
    assert.ok(file.error.length > 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('report file is git-excluded: repeated clean syncs stay no-op', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ga-report-'))
  try {
    await writeFile(join(root, 'a.txt'), 'one\n')
    const r1 = await syncWithReport(root, OPTS)
    assert.equal(r1.committed, true)

    // 无任何改动再 sync:报告文件的重写不得把工作区变脏
    const r2 = await syncWithReport(root, OPTS)
    assert.equal(r2.committed, false, 'report rewrite must not dirty the tree')

    const status = await exec('git', ['-C', root, 'status', '--porcelain'])
    assert.equal(status.stdout.trim(), '', 'workspace stays clean')

    const exclude = await readFile(join(root, '.git/info/exclude'), 'utf8')
    assert.match(exclude, /\.koinrokka\//)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
