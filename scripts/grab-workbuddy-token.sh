#!/usr/bin/env bash
#
# WeAuto —— WorkBuddy accessToken 抓取启动器（macOS）
#
# 由任务页生成，内嵌服务器地址与推送令牌，所以**不需要任何参数**。
# 它只做四件事：
#   1. 找一份能用的 Node.js（18+）：本机装了就用本机的，没装就下载官方 tarball
#      解到 ~/.weauto/node —— 不需要 sudo，不写 /usr/local，不改任何系统环境
#   2. 从服务器取抓取脚本
#   3. 把抓到的 token 推回 WeAuto
#   4. 删掉临时文件
#
# 【为什么 macOS 给的是 .sh + 一行命令，而不是双击就行的 .command】
#   浏览器下载不保留执行位（HTTP 不传 mode），权限 644 的 .command 双击毫无反应；
#   用 zip 保住权限又会撞 Gatekeeper 的隔离标记。所以这一侧始终是「下完 → 跑一行」。
#   那个 .sh 由 bash 执行，不依赖执行位，也不需要 chmod。
#
# 参数原样透传给抓取脚本（--push / --code / --push-token / --app / --print …）；
# 不带参数时用文件里内嵌的服务器与令牌。
#
# 退出码：0 成功 / 1 失败

set -u

# ── 以下三行由服务端注入，勿手改 ──
SERVER=""
PUSH_TOKEN=""
GRABBER=""

# 自举哪个版本的 Node。下载 URL 与解压后的目录名都由它推出来，只有这里要改。
NODE_VER="v24.22.2"
NODE_ROOT="$HOME/.weauto"

say() { printf '%s\n' "$*"; }

# 这份 node 能不能用：必须 >= 18，老版本没有全局 fetch，抓取脚本跑不起来。
# 也顺便挡住坏掉的包装器：跑不出 `vX.Y.Z` 就当它不存在。
node_ok() {
  local v
  v=$("$1" -v 2>/dev/null) || return 1
  v=${v#v}
  v=${v%%.*}
  case "$v" in
    '' | *[!0-9]*) return 1 ;;
  esac
  [ "$v" -ge 18 ]
}

# 之前自举过的那份（路径是确定的，不用去翻目录）。
cache_bin() {
  local arch
  case "$(uname -m)" in
    arm64) arch=arm64 ;;
    x86_64) arch=x64 ;;
    *) return 1 ;;
  esac
  printf '%s/node-%s-darwin-%s/bin/node\n' "$NODE_ROOT" "$NODE_VER" "$arch"
}

find_node() {
  local p cached
  p=$(command -v node 2>/dev/null) || p=""
  if [ -n "$p" ] && node_ok "$p"; then
    printf '%s\n' "$p"
    return 0
  fi
  cached=$(cache_bin) || return 1
  if [ -x "$cached" ] && node_ok "$cached"; then
    printf '%s\n' "$cached"
    return 0
  fi
  return 1
}

install_node() {
  local arch pkg tmp
  case "$(uname -m)" in
    arm64) arch=arm64 ;;
    x86_64) arch=x64 ;;
    *)
      say "不支持的 CPU 架构：$(uname -m)"
      return 1
      ;;
  esac
  pkg="node-$NODE_VER-darwin-$arch"

  say "准备一份 Node.js $NODE_VER（$arch，约 50MB，只装这一次）"
  say "解压到 $NODE_ROOT/$pkg —— 不需要 sudo，也不改系统环境"
  mkdir -p "$NODE_ROOT" || return 1
  tmp="$NODE_ROOT/$pkg.tar.gz"

  # 国内镜像优先：nodejs.org 在大陆经常几十 KB/s，50MB 会让人以为卡死
  if ! curl -fL --progress-bar -o "$tmp" "https://npmmirror.com/mirrors/node/$NODE_VER/$pkg.tar.gz"; then
    say "镜像没连上，换官方源再试一次…"
    if ! curl -fL --progress-bar -o "$tmp" "https://nodejs.org/dist/$NODE_VER/$pkg.tar.gz"; then
      rm -f "$tmp"
      return 1
    fi
  fi

  if ! tar -xzf "$tmp" -C "$NODE_ROOT"; then
    rm -f "$tmp"
    return 1
  fi
  rm -f "$tmp"

  # 解压出来不等于能跑（半截包、被杀软改写）；跑不起来就清掉，下次重来
  if ! node_ok "$NODE_ROOT/$pkg/bin/node"; then
    rm -rf "$NODE_ROOT/$pkg"
    return 1
  fi
  return 0
}

if [ -z "$SERVER" ]; then
  say "✗ 这份文件没有内嵌服务器地址，回任务页重新下载一份。"
  exit 1
fi
if [ -z "$GRABBER" ]; then
  GRABBER="grab-workbuddy-token.mjs"
fi

if ! NODE=$(find_node); then
  say "本机没有可用的 Node.js（需要 18 或更新）。"
  if ! install_node; then
    say ""
    say "✗ 没能自动准备好 Node.js。手动装一个再重跑本文件："
    say "    · 下载安装包：https://nodejs.org/zh-cn/download"
    say "    · 或者：brew install node"
    exit 1
  fi
  if ! NODE=$(find_node); then
    say "✗ 装完了仍然找不到可用的 node，请把上面的输出截图发给发你文件的人。"
    exit 1
  fi
fi

TMP="${TMPDIR:-/tmp}/weauto-grab-$$.mjs"
trap 'rm -f "$TMP"' EXIT INT TERM

say "取抓取脚本…"
if ! curl -fsSL "$SERVER/api/tools/$GRABBER" -o "$TMP"; then
  rm -f "$TMP"
  say "✗ 抓取脚本下载失败，检查网络后重试。"
  exit 1
fi

# 不带参数时用文件里内嵌的配对信息；带了参数就全交给用户
if [ $# -eq 0 ] && [ -n "$PUSH_TOKEN" ]; then
  set -- --push "$SERVER" --push-token "$PUSH_TOKEN"
fi

"$NODE" "$TMP" "$@"
