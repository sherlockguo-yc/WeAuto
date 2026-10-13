#!/bin/bash
#
# WeAuto 部署后置脚本 —— 由 deploy-agent.sh 在解压 Release 后调用
#
# WeAuto 是无端口被动 CLI，不存在「重启进程」这一步；
# 本脚本只做两件事：幂等准备运行环境（age 二进制）、收紧敏感文件权限。
#
set -uo pipefail

DIR="$HOME/weauto"
AGE_BIN="$HOME/.local/bin/age"
KEYGEN_BIN="$HOME/.local/bin/age-keygen"
KEY_FILE="$HOME/.age/weauto.key"
CACHE_DIR="$HOME/.cache/weauto"

log() { echo "[weauto] $*"; }

log "restart.sh 开始（$DIR）"

# ── 1. 确保 age 可用 ────────────────────────────────────────────────
if command -v age >/dev/null 2>&1; then
  log "age 已在 PATH 中：$(command -v age)"
elif [ -x "$AGE_BIN" ]; then
  log "age 已存在：$AGE_BIN"
else
  log "未找到 age，开始安装静态二进制…"
  mkdir -p "$HOME/.local/bin" "$CACHE_DIR"

  # 查询最新版本；失败则退回已知可用版本。两处都踩过坑（2026-10-13 实测）：
  #
  # 1. 必须直连 api.github.com。ghproxy 只代理 github.com 的下载资源，
  #    代理 api.github.com 会返回 403「Invalid input」，导致这里每次都拿不到版本
  #    而静默退回 v1.2.1 —— 部署看起来成功，实际从未跟进过新版本。
  #    （deploy-agent.sh 与 WeMonitor 的 lib/deploy/github.js 也是直连 API。）
  # 2. 用 node 解析 JSON 而不是 jq。jq 在 N150 上不保证存在，缺失时 `|| true`
  #    会把失败同样静默吞掉。
  VERSION="${WEAUTO_AGE_VERSION:-}"
  if [ -z "$VERSION" ]; then
    VERSION=$(curl -fsSL --max-time 20 \
      "https://api.github.com/repos/FiloSottile/age/releases/latest" \
      2>/dev/null | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).tag_name ?? ""' \
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
    log "✗ age 下载失败，任务将无法解密凭据"
    exit 0   # 不让部署整体失败，问题由任务运行时的 config-error 暴露
  fi

  tar -xzf "$TARBALL" -C "$CACHE_DIR" || { log "✗ 解压失败"; exit 0; }
  install -m 755 "$CACHE_DIR/age/age" "$AGE_BIN" || { log "✗ 安装 age 失败"; exit 0; }
  install -m 755 "$CACHE_DIR/age/age-keygen" "$KEYGEN_BIN" 2>/dev/null || true
  log "age 安装完成：$AGE_BIN"
fi

# ── 2. 收紧权限 ────────────────────────────────────────────────────
mkdir -p "$DIR/data"
chmod 700 "$DIR/data" 2>/dev/null || true
[ -f "$DIR/secrets.age" ] && chmod 600 "$DIR/secrets.age"

if [ -f "$KEY_FILE" ]; then
  chmod 600 "$KEY_FILE"
  log "age 私钥已就位：$KEY_FILE"
else
  log "⚠️  未找到 age 私钥 $KEY_FILE"
  log "    请手动放置（内容为本机 age-keygen 生成的私钥），否则任务会报 config-error"
fi

# ── 3. 自检：能否成功解密 ──────────────────────────────────────────
if [ -x "$AGE_BIN" ] && [ -f "$DIR/secrets.age" ] && [ -f "$KEY_FILE" ]; then
  if "$AGE_BIN" -d -i "$KEY_FILE" "$DIR/secrets.age" >/dev/null 2>&1; then
    log "凭据解密自检通过"
  else
    log "⚠️  凭据解密自检失败（请检查密钥与密文是否配对）"
  fi
fi

log "restart.sh 完成"
exit 0
