/**
 * Phase 0 acceptance checks against a running bridge.
 * Usage: node scripts/e2e-check.mjs <ws-url> <token>
 * Exit 0 = all pass. Prints one line per check.
 */
import WebSocket from 'ws'

const [url, token] = process.argv.slice(2)
if (!url || !token) {
  console.error('usage: node scripts/e2e-check.mjs <ws-url> <token>')
  process.exit(2)
}

let failed = 0
const report = (name, ok, detail = '') => {
  console.log(`    ${ok ? '✓' : '✗'} ${name}${detail ? ` (${detail})` : ''}`)
  if (!ok) failed++
}

// 1) wrong token rejected
{
  const ws = new WebSocket(`${url}/?token=wrong`)
  const code = await new Promise((resolve) => ws.on('close', resolve))
  report('wrong-token rejected', code === 4401 || code === 1006, `close=${code}`)
}

// 2) initialize handshake + 3) shutdown closes cleanly
{
  const ws = new WebSocket(`${url}/?token=${token}`)
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
  // 连接被关闭而回复未到时必须 reject(2026-09-29:曾无限悬挂成 unsettled top-level
  // await,验收只打一行 Warning 就静默 FAIL,排查代价极高)
  const nextReply = () => new Promise((resolve, reject) => {
    ws.on('message', (d) => resolve(JSON.parse(d.toString())))
    ws.on('close', (code) => reject(new Error(`connection closed before reply (close=${code})`)))
  })

  ws.send(JSON.stringify({
    jsonrpc: '2.0', id: 'acc-init', method: 'initialize',
    params: { sessionId: 'acceptance', cwd: '/tmp', provider: 'deepseek-official', model: 'deepseek-official' },
  }))
  const init = await nextReply()
  const serverInfo = init?.result?.serverInfo?.name
  report('initialize handshake ok', init.id === 'acc-init' && typeof serverInfo === 'string', serverInfo ?? JSON.stringify(init).slice(0, 80))

  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'acc-sd', method: 'shutdown', params: {} }))
  const sd = await nextReply()
  report('shutdown answered', sd?.id === 'acc-sd' && 'result' in sd)
  const code = await new Promise((resolve) => ws.on('close', resolve))
  report('shutdown closes connection cleanly', code === 1000, `close=${code}`)
}

process.exit(failed === 0 ? 0 : 1)
