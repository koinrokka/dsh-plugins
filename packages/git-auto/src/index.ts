/**
 * koinrokka git auto-layer (ADR 0007, Phase 3).
 *
 * Every turn/end auto-commits the workspace and pushes to the locker-bound
 * remote when one is configured. Git manages the code; the NAS volume manages
 * session memory; this plugin never interrupts the user and never builds
 * throwaway branches — one long-lived dev branch per locker.
 *
 * Failures are logged and swallowed: the auto layer must never break a turn.
 */

import type { Context } from '@deepseek-ai/cordis'
import { spawn } from 'node:child_process'

export const name = 'git-auto'

/** Deployment config; all fields optional. */
export interface GitAutoConfig {
  /** Long-lived branch for auto commits. @default 'koinrokka' */
  branch?: string
  /** Push remote URL. Falls back to KOINROKKA_GIT_REMOTE; absent = commit only. */
  remote?: string
  /** Commit identity. */
  identity?: { name?: string; email?: string }
}

export interface SyncOptions {
  branch: string
  remote?: string
  name: string
  email: string
}

export interface SyncResult {
  committed: boolean
  pushed: boolean
  subject?: string
}

function git(root: string, args: string[], input?: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolveP) => {
    const child = spawn('git', ['-C', root, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { err += c })
    child.on('error', (e) => resolveP({ code: -1, out: '', err: String(e) }))
    child.on('close', (code) => resolveP({ code: code ?? -1, out, err }))
    if (input !== undefined) child.stdin.end(input)
    else child.stdin.end()
  })
}

/**
 * One sync pass: ensure repo/identity/branch, add -A, commit if dirty, push if
 * a remote is configured. Pure fs+git — the test seam for this plugin.
 */
export async function syncWorkspace(root: string, opts: SyncOptions): Promise<SyncResult> {
  // repo 存在性:git rev-parse 成功即已在仓库内
  let probe = await git(root, ['rev-parse', '--git-dir'])
  if (probe.code !== 0) {
    const init = await git(root, ['init', '-q', '-b', opts.branch])
    if (init.code !== 0) throw new Error(`git init failed: ${init.err}`)
  }
  await git(root, ['config', 'user.name', opts.name])
  await git(root, ['config', 'user.email', opts.email])

  // 常驻分支:当前不在目标分支则建/切(孤儿场景不管,workspace 不会是别人的仓库)
  probe = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (probe.code !== 0 || probe.out.trim() !== opts.branch) {
    await git(root, ['switch', '-q', opts.branch]).catch(() => {})
    const sw = await git(root, ['switch', '-q', '-c', opts.branch])
    if (sw.code !== 0) throw new Error(`git switch ${opts.branch} failed: ${sw.err}`)
  }

  const add = await git(root, ['add', '-A'])
  if (add.code !== 0) throw new Error(`git add failed: ${add.err}`)

  const status = await git(root, ['status', '--porcelain'])
  if (status.code !== 0 || status.out.trim().length === 0) {
    return { committed: false, pushed: false }
  }

  const subject = `auto: turn ${new Date().toISOString()}`
  const commit = await git(root, ['commit', '-q', '-m', subject])
  if (commit.code !== 0) throw new Error(`git commit failed: ${commit.err}`)

  let pushed = false
  if (opts.remote) {
    const push = await git(root, ['push', '-q', opts.remote, `HEAD:${opts.branch}`])
    if (push.code !== 0) throw new Error(`git push failed: ${push.err}`)
    pushed = true
  }
  return { committed: true, pushed, subject }
}

export function apply(ctx: Context, config: GitAutoConfig = {}): void {
  const branch = config.branch ?? 'koinrokka'
  const remote = config.remote ?? process.env.KOINROKKA_GIT_REMOTE
  const name = config.identity?.name ?? 'koinrokka'
  const email = config.identity?.email ?? 'koinrokka@locker.local'

  // 单飞队列:turn 密集时合并为串行 sync,dirty 标记防丢
  let running = false
  let dirty = false
  let pendingRoot = process.cwd()
  const drain = (): void => {
    if (running || !dirty) return
    running = true
    dirty = false
    const root = pendingRoot
    void Promise.resolve(syncWorkspace(root, { branch, remote, name, email }))
      .then((r) => {
        if (r.committed) ctx.logger?.info?.(`git-auto: ${r.subject}${r.pushed ? ' (pushed)' : ''}`)
      })
      .catch((e) => {
        dirty = true // 下一个 turn 再试
        ctx.logger?.warn?.(`git-auto sync failed: ${e instanceof Error ? e.message : String(e)}`)
      })
      .finally(() => {
        running = false
        if (dirty) drain()
      })
  }

  // session/event 是 dsh-harness 层事件,不在 cordis 核心类型里;运行时由宿主 tree 广播
  const on = (ctx as unknown as { on: (name: string, fn: (...args: unknown[]) => void) => () => void }).on
  on('session/event', (...args: unknown[]) => {
    const session = args[0] as { meta?: { cwd?: string } } | null
    const event = args[1] as { type?: string }
    if (event?.type !== 'turn/end') return
    pendingRoot = session?.meta?.cwd ?? process.cwd()
    dirty = true
    drain()
  })
}
