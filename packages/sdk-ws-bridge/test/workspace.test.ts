/**
 * Workspace seam (S5): workspace/list|read|diff over the bridge WS, against a
 * temp workspace with a real git repo. Path escapes must be refused.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { WebSocket, WebSocketServer } from 'ws'
import { apply } from '../src/index.ts'

const TOKEN = 'test-token'
const PORT = 48709
const exec = promisify(execFile)

function once<T>(emitter: { once(event: string, listener: (value: T) => void): unknown }, event: string): Promise<T> {
  return new Promise((resolve) => emitter.once(event, resolve))
}

function mockContext(): { ctx: unknown; dispose: () => Promise<void> } {
  const disposers: Array<() => void> = []
  const ctx = {
    on: (): (() => void) => (): void => {},
    effect(fn: () => unknown): () => void {
      const dispose = fn() as () => void
      disposers.push((): void => { void Promise.resolve(dispose()).catch(() => {}) })
      return (): void => {}
    },
    get: (): undefined => undefined,
  }
  return { ctx, dispose: async () => { for (const dispose of disposers) dispose() } }
}

interface Rpc {
  call: (method: string, params?: Record<string, unknown>) => Promise<any>
  close: () => void
}

async function startBridge(root: string): Promise<{ rpc: Rpc; stop: () => Promise<void> }> {
  const { ctx, dispose } = mockContext()
  const origCwd = process.cwd()
  process.chdir(root) // workspaceRoot 在 apply 时取 process.cwd()
  try {
    apply(ctx as any, { host: '127.0.0.1', port: PORT, token: TOKEN })
  } finally {
    process.chdir(origCwd)
  }

  // 等端口可用(bridge 在 effect 里同步 create,监听几乎即时)
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${TOKEN}`)
  await once(ws, 'open')
  let nextId = 0
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>()
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString())
    if (msg.id !== undefined && pending.has(msg.id)) {
      const entry = pending.get(msg.id)!
      pending.delete(msg.id)
      if (msg.error) entry.reject(new Error(msg.error.message))
      else entry.resolve(msg.result)
    }
  })
  const rpc: Rpc = {
    call: (method, params) => new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }))
    }),
    close: () => ws.close(),
  }
  return {
    rpc,
    stop: async () => {
      rpc.close()
      await dispose()
    },
  }
}

test('workspace/list and workspace/read page a text file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ws-'))
  try {
    await mkdir(join(root, 'sub'))
    await writeFile(join(root, 'hello.py'), 'print(1)\nprint(2)\nprint(3)\n')
    await writeFile(join(root, 'sub', 'note.md'), '# note\n')

    const { rpc, stop } = await startBridge(root)
    try {
      const list = await rpc.call('workspace/list')
      const names = list.entries.map((e: any) => `${e.type}:${e.name}`).sort()
      assert.deepEqual(names, ['directory:sub', 'file:hello.py'])
      assert.equal(list.truncated, false)

      const sub = await rpc.call('workspace/list', { path: 'sub' })
      assert.deepEqual(sub.entries.map((e: any) => e.name), ['note.md'])

      const page = await rpc.call('workspace/read', { path: 'hello.py', offset: 2, limit: 1 })
      assert.equal(page.text, 'print(2)')
      assert.equal(page.lines, 1)
      assert.equal(page.eof, false)
    } finally {
      await stop()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('workspace paths cannot escape the root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ws-'))
  try {
    await writeFile(join(root, 'inside.txt'), 'ok\n')
    const outside = await mkdtemp(join(tmpdir(), 'ws-out-'))
    await writeFile(join(outside, 'secret.txt'), 'nope\n')

    const { rpc, stop } = await startBridge(root)
    try {
      await assert.rejects(
        rpc.call('workspace/read', { path: `../../${join(outside, 'secret.txt').split(sepSafe()).slice(-3).join('/')}` }),
        /escape/i,
      )
      await assert.rejects(rpc.call('workspace/read', { path: '/etc/passwd' }), /escape|ENOENT|error/i)
    } finally {
      await stop()
      await rm(outside, { recursive: true, force: true })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function sepSafe(): string {
  return process.platform === 'win32' ? '\\' : '/'
}

test('workspace/diff reports pending changes and the last auto commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ws-'))
  try {
    await exec('git', ['init', '-q'], { cwd: root })
    await exec('git', ['config', 'user.email', 't@t'], { cwd: root })
    await exec('git', ['config', 'user.name', 't'], { cwd: root })
    await writeFile(join(root, 'a.txt'), 'one\n')
    await exec('git', ['add', '-A'], { cwd: root })
    await exec('git', ['commit', '-qm', 'auto: turn 1'], { cwd: root })
    await writeFile(join(root, 'b.txt'), 'two\n')

    const { rpc, stop } = await startBridge(root)
    try {
      const diff = await rpc.call('workspace/diff')
      assert.ok(diff.untracked.includes('b.txt'), `untracked: ${JSON.stringify(diff.untracked)}`)
      assert.equal(diff.lastTurn.subject, 'auto: turn 1')
      assert.match(diff.lastTurn.stat, /a\.txt/)
    } finally {
      await stop()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
