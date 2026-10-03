/**
 * 审批桥核心(R2/ADR 0022):ApprovalBroker 纯逻辑 + toolName → 五级映射。
 * 语义:人决只有 allowed-once/rejected;超时 = unavailable(fail-closed);
 * signal 中止 = cancelled;系统态不可由浏览器伪造。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { ApprovalBroker, levelOf } from '../src/approval.ts'

test('levelOf maps known tools to the five levels (case-insensitive)', () => {
  assert.equal(levelOf('read'), 'READ')
  assert.equal(levelOf('search'), 'READ')
  assert.equal(levelOf('Grep'), 'READ')
  assert.equal(levelOf('write'), 'WRITE')
  assert.equal(levelOf('edit'), 'WRITE')
  assert.equal(levelOf('bash'), 'EXECUTE')
  assert.equal(levelOf('rm'), 'DESTRUCTIVE')
  assert.equal(levelOf('destroy'), 'DESTRUCTIVE')
  assert.equal(levelOf('deploy'), 'DEPLOY')
})

test('levelOf defaults unknown tools to EXECUTE (审慎默认档)', () => {
  assert.equal(levelOf('mystery_tool'), 'EXECUTE')
  assert.equal(levelOf('custom-thing'), 'EXECUTE')
})

test('broker resolves a human decision by id', async () => {
  const b = new ApprovalBroker(10_000)
  const { pending, outcome } = b.ask({ toolName: 'bash', reason: 'rm -rf build' })
  assert.equal(pending.level, 'EXECUTE')
  assert.equal(pending.toolName, 'bash')
  assert.equal(pending.reason, 'rm -rf build')
  assert.ok(pending.expiresAt > Date.now())
  assert.equal(b.decide(pending.id, 'allowed-once'), true)
  assert.equal(await outcome, 'allowed-once')
  assert.equal(b.pendingCount(), 0)
})

test('broker rejects unknown id or forged system outcome', async () => {
  const b = new ApprovalBroker(10_000)
  const { pending, outcome } = b.ask({ toolName: 'write' })
  assert.equal(b.decide('apr-nope', 'allowed-once'), false)
  assert.equal(b.decide(pending.id, 'cancelled' as 'allowed-once'), false, '系统态不可伪造')
  assert.equal(b.decide(pending.id, 'rejected'), true)
  assert.equal(await outcome, 'rejected')
})

test('broker times out to unavailable (fail-closed)', async () => {
  const b = new ApprovalBroker(1_000) // 最小档 1s
  const { outcome } = b.ask({ toolName: 'bash' })
  assert.equal(await outcome, 'unavailable')
  assert.equal(b.pendingCount(), 0)
})

test('broker settles cancelled on abort signal', async () => {
  const b = new ApprovalBroker(10_000)
  const ac = new AbortController()
  const { outcome } = b.ask({ toolName: 'bash', signal: ac.signal })
  ac.abort()
  assert.equal(await outcome, 'cancelled')
  assert.equal(b.pendingCount(), 0)
})
