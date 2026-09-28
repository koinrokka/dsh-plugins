/**
 * git-auto seam:syncWorkspace against a temp workspace and a bare remote.
 * init / no-op / commit-on-change / push behaviors are the contract.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { syncWorkspace } from '../src/index.ts'

const exec = promisify(execFile)

const OPTS = {
  branch: 'koinrokka',
  remote: undefined as string | undefined,
  name: 'koinrokka',
  email: 'koinrokka@locker.local',
}

test('syncWorkspace inits a repo and commits dirty state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ga-'))
  try {
    await writeFile(join(root, 'hello.py'), 'print("hi")\n')
    const r1 = await syncWorkspace(root, OPTS)
    assert.equal(r1.committed, true)
    assert.match(r1.subject!, /^auto: /)

    // 干净时 no-op
    const r2 = await syncWorkspace(root, OPTS)
    assert.equal(r2.committed, false)

    // 再改再提交
    await writeFile(join(root, 'hello.py'), 'print("hi2")\n')
    const r3 = await syncWorkspace(root, OPTS)
    assert.equal(r3.committed, true)

    const log = await exec('git', ['-C', root, 'log', '--oneline'], { maxBuffer: 1 << 20 })
    assert.equal(log.stdout.trim().split('\n').length, 2, 'two auto commits expected')
    const branch = await exec('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'])
    assert.equal(branch.stdout.trim(), 'koinrokka')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('syncWorkspace pushes to the configured remote', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ga-'))
  const bare = await mkdtemp(join(tmpdir(), 'ga-bare-'))
  try {
    await exec('git', ['init', '-q', '--bare', '-b', 'koinrokka', bare])
    await writeFile(join(root, 'a.txt'), 'one\n')
    const r = await syncWorkspace(root, { ...OPTS, remote: bare })
    assert.equal(r.committed, true)
    assert.equal(r.pushed, true)

    const refs = await exec('git', ['-C', bare, 'log', '--oneline', 'koinrokka'])
    assert.match(refs.stdout, /auto: /)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(bare, { recursive: true, force: true })
  }
})

test('syncWorkspace without remote commits but never pushes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ga-'))
  try {
    await writeFile(join(root, 'b.txt'), 'x\n')
    const r = await syncWorkspace(root, OPTS)
    assert.equal(r.committed, true)
    assert.equal(r.pushed, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
