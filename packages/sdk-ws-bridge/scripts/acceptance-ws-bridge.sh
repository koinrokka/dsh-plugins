#!/usr/bin/env bash
# Phase 0 人工验收:一键重放(幂等)。
# 流程:单测+构建 → 准备临时 profile → 起 dsh(bridge 监听 7800)→ 检查 → 清理。
set -euo pipefail
cd "$(dirname "$0")/../../.."

PROFILE=koinrokka-acceptance
TOKEN="acceptance-$(date +%s)"
PORT=7800
# dsh 版本与 bridge peerDependencies 同源钉死:@latest 已漂到 0.2.0-rc.2,peer 不兼容
# 会被 plugin manager 拒装(2026-09-30 重放踩坑);不跨仓读 runtime/versions.yaml(依赖方向)
DSH_VER=$(node -p "require('./packages/sdk-ws-bridge/package.json').peerDependencies['@deepseek-ai/dsh-agent']")

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

echo "==> [2/4] 准备 profile: $PROFILE(dsh@$DSH_VER)"
# profile 残留其他 dsh 版本时必须重建(否则 plugin 装入错版本环境,重放必炸)
PIN_FILE="$HOME/.dsh/profiles/$PROFILE/.koinrokka-dsh-pin"
if [ ! -d "$HOME/.dsh/profiles/$PROFILE" ] || [ "$(cat "$PIN_FILE" 2>/dev/null)" != "$DSH_VER" ]; then
  rm -rf "$HOME/.dsh/profiles/$PROFILE"
  npx -y @deepseek-ai/dsh@${DSH_VER} --profile "$PROFILE" --from-default-profile sdk >/dev/null 2>&1
  echo "$DSH_VER" >"$PIN_FILE"
fi
for attempt in 1 2; do
  BUNDLES=$(grep -c 'koinrokka/dsh-sdk-ws-bridge' "$HOME/.dsh/profiles/$PROFILE/package.json" || true)
  [ "$BUNDLES" -ge 1 ] && break
  npx -y @deepseek-ai/dsh@${DSH_VER} plugin --profile "$PROFILE" add "$PWD/packages/sdk-ws-bridge" | tail -3
  sleep 2
done
grep -q 'koinrokka/dsh-sdk-ws-bridge' "$HOME/.dsh/profiles/$PROFILE/package.json" \
  || { echo "bundle 未装入 profile,见上方输出"; exit 1; }

echo "==> [3/4] 启动 dsh(token=$TOKEN)"
# 端口预检:7800 上有残留(上次验收的孤儿 dsh)必须大声拒跑,否则四项检查打到
# 旧进程上,token 对不上只会表现为 initialize 悬挂(2026-09-29 跨机验收踩坑)
# 端口探测用 bash 内建 /dev/tcp(零依赖);pid 取证用 lsof(缺失时降级「pid 未知」)
port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
if port_open "$PORT"; then
  STALE_PID=$(lsof -t -i tcp:"$PORT" 2>/dev/null | head -1)
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
# setsid 是 util-linux(Linux)专属,macOS 无;有则杀整组最干净,无则退回直接
# 后台 + cleanup 的 pkill 兜底(坑二修复已保证孤儿可清)
if command -v setsid >/dev/null 2>&1; then
  KOINROKKA_BRIDGE_TOKEN="$TOKEN" setsid npx -y @deepseek-ai/dsh@${DSH_VER} --profile "$PROFILE" >/dev/null 2>&1 &
else
  KOINROKKA_BRIDGE_TOKEN="$TOKEN" npx -y @deepseek-ai/dsh@${DSH_VER} --profile "$PROFILE" >/dev/null 2>&1 &
fi
DSH_PID=$!

for i in $(seq 1 60); do
  port_open "$PORT" && break
  kill -0 "$DSH_PID" 2>/dev/null || { echo "dsh 进程退出"; exit 1; }
  sleep 1
done
port_open "$PORT" || { echo "7800 未监听"; exit 1; }
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
