#!/usr/bin/env bash
# Phase 0 人工验收:一键重放(幂等)。
# 流程:单测+构建 → 准备临时 profile → 起 dsh(bridge 监听 7800)→ 检查 → 清理。
set -euo pipefail
cd "$(dirname "$0")/../../.."

PROFILE=koinrokka-acceptance
TOKEN="acceptance-$(date +%s)"
PORT=7800

echo "==> [1/4] 单测 + 构建"
pnpm install --frozen-lockfile >/dev/null
pnpm build >/dev/null
# node:test 输出格式随管道与否变化(spec 报告器带 ℹ,回落 TAP 报 # ),
# 两种都要认;测试真失败要大声报,不许靠 grep 静默退出(2026-09-29 跨机验收踩坑)
TESTLOG=$(mktemp)
if ! pnpm test >"$TESTLOG" 2>&1; then
  echo "✗ 单测失败:"; tail -30 "$TESTLOG"; rm -f "$TESTLOG"; exit 1
fi
grep -E '(ℹ|#) (pass|fail)' "$TESTLOG" | tail -2
rm -f "$TESTLOG"

echo "==> [2/4] 准备 profile: $PROFILE"
if [ ! -d "$HOME/.dsh/profiles/$PROFILE" ]; then
  npx -y @deepseek-ai/dsh@latest --profile "$PROFILE" --from-default-profile sdk >/dev/null 2>&1
fi
for attempt in 1 2; do
  BUNDLES=$(grep -c 'koinrokka/dsh-sdk-ws-bridge' "$HOME/.dsh/profiles/$PROFILE/package.json" || true)
  [ "$BUNDLES" -ge 1 ] && break
  npx -y @deepseek-ai/dsh@latest plugin --profile "$PROFILE" add "$PWD/packages/sdk-ws-bridge" | tail -3
  sleep 2
done
grep -q 'koinrokka/dsh-sdk-ws-bridge' "$HOME/.dsh/profiles/$PROFILE/package.json" \
  || { echo "bundle 未装入 profile,见上方输出"; exit 1; }

echo "==> [3/4] 启动 dsh(token=$TOKEN)"
# 端口预检:7800 上有残留(上次验收的孤儿 dsh)必须大声拒跑,否则四项检查打到
# 旧进程上,token 对不上只会表现为 initialize 悬挂(2026-09-29 跨机验收踩坑)
if ss -tln 2>/dev/null | grep -q ":$PORT "; then
  STALE_PID=$(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -oE 'pid=[0-9]+' | head -1)
  echo "✗ 端口 $PORT 已被占用(${STALE_PID:-pid 未知};疑似上次验收残留的 dsh 孤儿进程)"
  echo "  清理:pkill -f 'dsh --profile $PROFILE' 后重放"
  exit 1
fi
DSH_PID=""
# setsid 建新进程组,cleanup 杀整组:npx 只是包装器,只杀它会给真正的 node/dsh
# 子进程留孤儿,继续占着 7800 毒化下一次验收
cleanup() {
  [ -n "$DSH_PID" ] && kill -- "-$DSH_PID" 2>/dev/null || true
  pkill -f "dsh --profile $PROFILE" 2>/dev/null || true
}
trap cleanup EXIT
KOINROKKA_BRIDGE_TOKEN="$TOKEN" setsid npx -y @deepseek-ai/dsh@latest --profile "$PROFILE" >/dev/null 2>&1 &
DSH_PID=$!

for i in $(seq 1 60); do
  ss -tln 2>/dev/null | grep -q ":$PORT " && break
  kill -0 "$DSH_PID" 2>/dev/null || { echo "dsh 进程退出"; exit 1; }
  sleep 1
done
ss -tln | grep -q ":$PORT " || { echo "7800 未监听"; exit 1; }
echo "    bridge listening on :$PORT"

echo "==> [4/4] 四项检查"
set +e
node packages/sdk-ws-bridge/scripts/e2e-check.mjs "ws://127.0.0.1:$PORT" "$TOKEN"
RESULT=$?
set -e

sleep 1
if kill -0 "$DSH_PID" 2>/dev/null; then
  echo "    ✓ process survives shutdown (bridge semantics)"
else
  echo "    ✗ process died after shutdown"
  RESULT=1
fi

echo
[ "$RESULT" -eq 0 ] && echo "PHASE-0 ACCEPTANCE: PASS" || echo "PHASE-0 ACCEPTANCE: FAIL"
exit "$RESULT"
