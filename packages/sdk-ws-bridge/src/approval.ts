/**
 * 审批桥核心(R2/ADR 0022):dsh 的 approval/request 瀑布事件 ↔ 浏览器审批卡。
 *
 * 语义对齐 @deepseek-ai/dsh-user-approval(0.1.5-rc.3 实测):
 *   outcome = allowed-once | rejected | cancelled | unavailable;
 *   无人应答 = unavailable,调用方 fail-closed——我们不改这一点,
 *   只把「应答者」从无人变成「浏览器里的人」(经 sdk-ws-bridge 的 WS)。
 *
 * 五级分级(ADR 0022):READ / WRITE / EXECUTE / DEPLOY / DESTRUCTIVE;
 * toolName → 级别由规则表推导,未知工具保守按 EXECUTE(人审默认档)。
 */

import { randomUUID } from 'node:crypto'

export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'
export type ApprovalLevel = 'READ' | 'WRITE' | 'EXECUTE' | 'DEPLOY' | 'DESTRUCTIVE'

const LEVEL_RULES: [RegExp, ApprovalLevel][] = [
  [/^(read|view|cat|ls|list|search|grep|find|glob|stat)$/, 'READ'],
  [/^(rm|remove|delete|drop|destroy|format|truncate|clean)$/, 'DESTRUCTIVE'],
  [/^(deploy|publish|release|ship|rollback)$/, 'DEPLOY'],
  [/^(write|edit|patch|mkdir|touch|mv|rename)$/, 'WRITE'],
  [/^(bash|exec|run|shell|terminal|sh|python|node|npm|pnpm)$/, 'EXECUTE'],
]

/** toolName → 五级;规则表外的工具 = EXECUTE(审慎默认) */
export function levelOf (toolName: string): ApprovalLevel {
  const n = toolName.toLowerCase()
  for (const [re, level] of LEVEL_RULES) {
    if (re.test(n)) return level
  }
  return 'EXECUTE'
}

/** 推给浏览器的挂起单(payload 即 WS 通知 params) */
export interface PendingApproval {
  id: string
  toolName: string
  reason?: string
  level: ApprovalLevel
  /** 超时时刻(epoch ms),浏览器据此画倒计时 */
  expiresAt: number
}

export interface AskInput {
  toolName: string
  reason?: string
  /** dsh 侧的中止信号(回合取消等):settle 为 cancelled */
  signal?: AbortSignal
}

type Settled = (outcome: ApprovalOutcome) => void

export class ApprovalBroker {
  readonly timeoutMs: number
  #pending = new Map<string, { resolve: Settled, timer: NodeJS.Timeout }>()
  #nextId = 0

  constructor (timeoutMs: number) {
    this.timeoutMs = Math.max(1_000, timeoutMs)
  }

  /** 发起一次审批:立即返回挂起单与结果 promise;decided / 超时 / signal 中止三者先到先 settle */
  ask (input: AskInput): { pending: PendingApproval, outcome: Promise<ApprovalOutcome> } {
    const id = `apr-${++this.#nextId}-${randomUUID().slice(0, 8)}`
    let resolve: Settled | undefined
    const outcome = new Promise<ApprovalOutcome>((r) => { resolve = r })
    const entry = {
      resolve: resolve!,
      timer: setTimeout(() => this.#settle(id, 'unavailable'), this.timeoutMs),
    }
    entry.timer.unref?.()
    this.#pending.set(id, entry)
    input.signal?.addEventListener('abort', () => this.#settle(id, 'cancelled'), { once: true })
    return {
      pending: {
        id,
        toolName: input.toolName,
        reason: input.reason,
        level: levelOf(input.toolName),
        expiresAt: Date.now() + this.timeoutMs,
      },
      outcome,
    }
  }

  /** 浏览器决定:只接受人决二值;cancelled/unavailable 是系统态,不可伪造 */
  decide (id: string, outcome: 'allowed-once' | 'rejected'): boolean {
    if (outcome !== 'allowed-once' && outcome !== 'rejected') return false
    return this.#settle(id, outcome)
  }

  #settle (id: string, outcome: ApprovalOutcome): boolean {
    const entry = this.#pending.get(id)
    if (!entry) return false
    clearTimeout(entry.timer)
    this.#pending.delete(id)
    entry.resolve(outcome)
    return true
  }

  pendingCount (): number {
    return this.#pending.size
  }
}
