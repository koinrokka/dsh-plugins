/**
 * Workspace surface for the bridge (Phase 3, ADR 0010): file tree, paged text
 * reads, and turn diffs for the browser IDE. Backed by plain fs + git in the
 * locker container — same world the agent works in, no second source of truth.
 *
 * Paths are workspace-relative; every access resolves against the workspace
 * root and refuses to escape it. Sizes and pages are capped.
 */

import { spawn } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

export const WORKSPACE_MAX_ENTRIES = 1000
export const WORKSPACE_MAX_LINES = 2000
export const WORKSPACE_DIFF_MAX_BYTES = 200_000

export interface WorkspaceEntry {
  name: string
  type: 'file' | 'directory' | 'other'
  size?: number
}

function inside(root: string, path: string): string {
  const target = resolve(root, path)
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`path escapes workspace: ${path}`)
  }
  return target
}

/** One page of a text file: 1-based lines, joined with `\n`. */
async function readPage(root: string, path: string, offset: number, limit: number): Promise<{
  absolutePath: string
  offset: number
  text: string
  lines: number
  eof: boolean
}> {
  const absolutePath = inside(root, path)
  const raw = await readFile(absolutePath, 'utf8')
  const all = raw.length === 0 ? [] : raw.split('\n')
  const start = Math.max(1, offset) - 1
  const page = all.slice(start, start + limit)
  const eof = start + page.length >= all.length
  return {
    absolutePath,
    offset: start + 1,
    text: page.join('\n'),
    lines: page.length,
    eof,
  }
}

function git(root: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolveP) => {
    const child = spawn('git', ['-C', root, '--no-pager', ...args], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let out = ''
    let total = 0
    child.stdout.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total <= WORKSPACE_DIFF_MAX_BYTES) out += chunk.toString('utf8')
    })
    child.on('error', () => resolveP({ code: -1, out: '' }))
    child.on('close', (code) => resolveP({ code: code ?? -1, out }))
  })
}

/**
 * Handle one `workspace/*` JSON-RPC request. Unknown methods throw (transport
 * answers with a JSON-RPC error), mirroring the SDK server's contract.
 */
export async function handleWorkspaceRequest(
  root: string,
  method: string,
  params: Record<string, unknown> | undefined,
): Promise<unknown> {
  const p = params ?? {}
  switch (method) {
    case 'workspace/list': {
      const rel = typeof p.path === 'string' ? p.path : ''
      const dir = inside(root, rel)
      const dirents = await readdir(dir, { withFileTypes: true })
      const entries: WorkspaceEntry[] = []
      for (const d of dirents) {
        if (d.name === '.git' || d.name === '.dsh') continue
        let type: WorkspaceEntry['type'] = 'other'
        if (d.isFile()) type = 'file'
        else if (d.isDirectory()) type = 'directory'
        let size: number | undefined
        if (type === 'file') {
          try { size = (await stat(join(dir, d.name))).size } catch { /* raced away */ }
        }
        entries.push({ name: d.name, type, size })
      }
      entries.sort((a, b) => a.name.localeCompare(b.name))
      const truncated = entries.length > WORKSPACE_MAX_ENTRIES
      return { path: rel, entries: entries.slice(0, WORKSPACE_MAX_ENTRIES), truncated }
    }
    case 'workspace/read': {
      if (typeof p.path !== 'string') throw new Error('workspace/read requires path')
      const offset = typeof p.offset === 'number' ? p.offset : 1
      const limit = Math.min(
        typeof p.limit === 'number' ? p.limit : WORKSPACE_MAX_LINES,
        WORKSPACE_MAX_LINES,
      )
      return readPage(root, p.path, offset, limit)
    }
    case 'workspace/diff': {
      const pending = await git(root, ['diff', 'HEAD'])
      const status = await git(root, ['status', '--porcelain'])
      const untracked = status.code === 0
        ? status.out.split('\n')
            .filter((l) => l.startsWith('?? '))
            .map((l) => l.slice(3).trim())
        : []
      const log = await git(root, ['log', '-1', '--format=%s'])
      const statOut = await git(root, ['show', '--stat', '--format=', 'HEAD'])
      const lastTurn = log.code === 0 && log.out.trim().length > 0
        ? { subject: log.out.trim(), stat: statOut.out.trim() }
        : null
      return { pending: pending.code === 0 ? pending.out : '', untracked, lastTurn }
    }
    default:
      throw new Error(`unknown workspace method: ${method}`)
  }
}
