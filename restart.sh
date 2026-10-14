#!/bin/bash
#
# WeAuto 部署后置脚本 —— 由 deploy-agent.sh 在解压 Release 后调用
#
# WeAuto 现在是常驻服务（端口 18991）。本脚本做三件事：
#   1. 幂等准备运行环境（age 二进制）—— 凭据解密依赖它
#   2. 收紧敏感文件权限
#   3. 停掉旧进程并重新拉起常驻服务，然后验证端口真的起来了
#
# 退出码有意义：起不来就返回 1，让 deploy-agent 把它标成失败并继续重试。
# 「启动失败却报告成功」是这类服务最难查的故障，不能用 exit 0 把它盖掉。
#
set -uo pipefail

DIR="$HOME/weauto"
PORT=18991
LOG=/tmp/weauto.log
AGE_BIN="$HOME/.local/bin/age"
KEYGEN_BIN="$HOME/.local/bin/age-keygen"
KEY_FILE="$HOME/.age/weauto.key"
CACHE_DIR="$HOME/.cache/weauto"

log() { echo "[weauto] $*"; }

# 与 crontab 里保持一致：优先用 N150 上那个绝对路径的 node
if [ -x /usr/local/bin/node ]; then
  NODE=/usr/local/bin/node
else
  NODE="$(command -v node || echo node)"
fi

log "restart.sh 开始（$DIR，node=$NODE）"

# ── 1. 确保 age 可用 ────────────────────────────────────────────────
if command -v age >/dev/null 2>&1; then
  log "age 已在 PATH 中：$(command -v age)"
elif [ -x "$AGE_BIN" ]; then
  log "age 已存在：$AGE_BIN"
else
  log "未找到 age，开始安装静态二进制…"
  mkdir -p "$HOME/.local/bin" "$CACHE_DIR"

  # 两处都踩过坑（2026-10-13 实测）：
  # 1. 必须直连 api.github.com —— ghproxy 代理它会返回 403，导致每次都静默
  #    退回 v1.2.1（部署看起来成功，实际从未跟进新版本）
  # 2. 用 node 解析 JSON 而不是 jq —— jq 在 N150 上不保证存在，缺失时 `|| true`
  #    会把失败同样静默吞掉
  VERSION="${WEAUTO_AGE_VERSION:-}"
  if [ -z "$VERSION" ]; then
    VERSION=$(curl -fsSL --max-time 20 \
      "https://api.github.com/repos/FiloSottile/age/releases/latest" \
      2>/dev/null | "$NODE" -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).tag_name ?? ""' \
      2>/dev/null || true)
  fi
  VERSION="${VERSION:-v1.2.1}"
  log "目标版本：$VERSION"

  TARBALL="$CACHE_DIR/age-$VERSION.tar.gz"
  URL_MIRROR="https://ghproxy.net/https://github.com/FiloSottile/age/releases/download/$VERSION/age-$VERSION-linux-amd64.tar.gz"
  URL_DIRECT="https://github.com/FiloSottile/age/releases/download/$VERSION/age-$VERSION-linux-amd64.tar.gz"

  if curl -fsSL --max-time 120 "$URL_MIRROR" -o "$TARBALL"; then
    log "镜像下载成功"
  elif curl -fsSL --max-time 180 "$URL_DIRECT" -o "$TARBALL"; then
    log "直连下载成功"
  else
    log "✗ age 下载失败，任务将无法解密凭据（服务仍会启动）"
  fi

  if [ -f "$TARBALL" ]; then
    tar -xzf "$TARBALL" -C "$CACHE_DIR" 2>/dev/null && \
      install -m 755 "$CACHE_DIR/age/age" "$AGE_BIN" && \
      install -m 755 "$CACHE_DIR/age/age-keygen" "$KEYGEN_BIN" 2>/dev/null
    [ -x "$AGE_BIN" ] && log "age 安装完成：$AGE_BIN"
  fi
fi

# ── 2. 收紧权限 ────────────────────────────────────────────────────
mkdir -p "$DIR/data"
chmod 700 "$DIR/data" 2>/dev/null || true
[ -f "$DIR/secrets.age" ] && chmod 600 "$DIR/secrets.age"
[ -f "$DIR/data/jwt-secret" ] && chmod 600 "$DIR/data/jwt-secret"

if [ -f "$KEY_FILE" ]; then
  chmod 600 "$KEY_FILE"
  log "age 私钥已就位"
else
  log "⚠️  未找到 age 私钥 $KEY_FILE（任务会报 config-error）"
fi

# ── 3. 停掉旧进程 ──────────────────────────────────────────────────
OLD_PID=$(lsof -ti:$PORT 2>/dev/null)
if [ -n "$OLD_PID" ]; then
  kill $OLD_PID 2>/dev/null
  sleep 2
  # 优雅退出失败再强杀。服务收到 SIGTERM 会自己收尾（停调度器、关库）
  kill -9 $OLD_PID 2>/dev/null
  log "已停止旧进程 PID $OLD_PID"
fi

# ── 4. 启动常驻服务 ────────────────────────────────────────────────
cd "$DIR" || { log "✗ 目录不存在：$DIR"; exit 1; }
[ -f "$DIR/.env" ] && . "$DIR/.env"

# nohup + 后台：脚本本身必须能在几秒内返回，deploy-agent 才不会卡住
nohup "$NODE" bin/weauto-serve.mjs >> "$LOG" 2>&1 &

# 等端口起来（最多 15 秒）
for i in $(seq 1 15); do
  NEW_PID=$(lsof -ti:$PORT 2>/dev/null)
  [ -n "$NEW_PID" ] && break
  sleep 1
done

NEW_PID=$(lsof -ti:$PORT 2>/dev/null)
if [ -n "$NEW_PID" ]; then
  log "✓ 启动成功 PID $NEW_PID 端口 $PORT（v $(cat "$DIR/.version" 2>/dev/null || echo unknown)）"
  exit 0
fi

log "✗ 启动失败，最近日志："
tail -20 "$LOG" 2>/dev/null
exit 1
