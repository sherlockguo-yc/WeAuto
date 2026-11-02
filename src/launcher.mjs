/**
 * Windows 双击启动器（批处理正文生成器）。
 *
 * 【它要解决的三个问题】
 *   1. 用户不在终端敲命令：双击就行（`.cmd` 走文件关联，不需要执行位）。
 *   2. WorkBuddy 的 token 只能从客户端进程内存里抓，所以启动器只负责把它拉起来跑脚本。
 *   3. **本机可能根本没装 Node.js**。以前这里是 `exit /b 1`，用户看到一行英文报错就
 *      卡死在那儿——对一个"下载完双击"的人是死路。现在改成自举：装一份**便携版**
 *      Node 到 `%LOCALAPPDATA%\WeAuto\node`，然后继续往下跑。
 *
 * 【为什么是便携 zip 而不是官方 MSI】
 *   · 装 MSI 要管理员权限（UAC 弹窗 + 公司电脑通常不给装），便携版写到用户自己的
 *     LOCALAPPDATA，不需要任何提权；
 *   · 不写注册表、不改 PATH：运行时用绝对路径调它，"配置"这一步因此不存在，
 *     卸载就是删目录；
 *   · 失败面小：解压就是 `Expand-Archive`（`tar.exe` 兜底），不涉及 Windows Installer。
 *
 * 【为什么正文是纯 ASCII 英文】
 *   批处理里的中文要靠 `chcp 65001` + UTF-8 文件才能显示，个别 Windows 版本会出
 *   乱码方块。真正给用户看的中文（抓取结果、下一步）由 node 跑的那份 .mjs 输出，
 *   那里是 UTF-8 控制台，稳定。所以"要装 Node 了"这类提示留给网页上的中文说明，
 *   控制台只说必要的英文。
 */

/** 启动器的文件名：压缩包里、Content-Disposition 里都用它，只写一处 */
export const LAUNCHER_FILE = 'update-workbuddy-token.cmd';

/**
 * 自举哪个版本的 Node。
 *
 * 三处必须一致：下载 URL、解压后的目录名（`node-vX-win-x64`）、版本检查里的大版本号
 * ——后两者都由这个常量推出来，所以只有这里需要改。选 LTS 而不是 latest：
 * 目标机器可能是 Win10 + 老杀软，LTS 的兼容面更大。
 */
export const NODE_BOOTSTRAP_VER = 'v24.22.2';

/**
 * @param {object} opts
 * @param {string} opts.server 服务器地址（写死进文件，运行时不再问）
 * @param {string|null} opts.pushToken 长期推送令牌；不给就退化成「抓完复制到剪贴板」
 * @param {{download: string}} opts.helper 凭据抓取脚本的文件名（从公开端点现取）
 * @returns {string} 批处理正文，CRLF 分隔
 */
export function launcherCmd({ server, pushToken, helper }) {
  /** 有令牌就自动推送；没有就抓完只放剪贴板，由用户自己粘到网页上 */
  const pushVar = pushToken ? `set "PUSH_TOKEN=${pushToken}"` : null;
  const runLine = pushToken
    ? '"%NODE_EXE%" "%TMPFILE%" --push "%SERVER%" --push-token "%PUSH_TOKEN%"'
    : '"%NODE_EXE%" "%TMPFILE%"';

  const lines = [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal',
    'title WorkBuddy token updater',
    `set "SERVER=${server}"`,
    ...(pushVar ? [pushVar] : []),
    'set "TMPFILE=%TEMP%\\wb-grab-%RANDOM%%RANDOM%.mjs"',
    '',
    'rem Portable Node.js, prepared on first run under %LOCALAPPDATA% (no admin,',
    'rem no PATH changes). Version, folder name and the >=18 check must agree.',
    `set "NODE_VER=${NODE_BOOTSTRAP_VER}"`,
    'set "NODE_PKG=node-%NODE_VER%-win-x64"',
    'set "NODE_HOME=%LOCALAPPDATA%\\WeAuto\\node"',
    'set "NODE_CACHED=%NODE_HOME%\\%NODE_PKG%\\node.exe"',
    '',
    'call :ensure_node',
    'if not defined NODE_EXE goto :no_node',
    '',
    'echo Fetching grabber...',
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -UseBasicParsing -Uri '${server}/api/tools/${helper.download}' -OutFile '%TMPFILE%' } catch { exit 1 }"`,
    'if not exist "%TMPFILE%" (',
    `  curl.exe -fsS -o "%TMPFILE%" "${server}/api/tools/${helper.download}" >nul 2>nul`,
    ')',
    'if not exist "%TMPFILE%" (',
    '  echo Download failed. Check your network and try again.',
    '  echo.',
    '  pause',
    '  exit /b 1',
    ')',
    '',
    'echo Updating WorkBuddy token...',
    'echo.',
    runLine,
    'set "RC=%ERRORLEVEL%"',
    'del "%TMPFILE%" >nul 2>nul',
    'echo.',
    'pause',
    'exit /b %RC%',
    '',
    ':no_node',
    'echo.',
    'echo Could not prepare a Node.js runtime automatically.',
    'echo Nothing else on this machine was changed.',
    'echo   * Install the LTS from https://nodejs.org/ and run this file again.',
    'echo   * Or ask the person who sent you this file for help.',
    'echo.',
    'pause',
    'exit /b 1',
    '',
    ':ensure_node',
    'set "NODE_EXE="',
    'set "NODE_OK="',
    'rem 1) Node on PATH, 18 or newer (older releases have no global fetch)',
    'set "VER="',
    'for /f "delims=" %%v in (\'node -v 2^>nul\') do set "VER=%%v"',
    'if not defined VER goto :ensure_cached',
    'call :accept_ver "%VER%"',
    'if not defined NODE_OK goto :ensure_cached',
    'rem Resolve the absolute path instead of calling a quoted bare name: cmd has a',
    'rem special rule for command lines that open with a quote, and depending on how',
    'rem many quotes follow it decides to strip them. Not worth betting on.',
    'for /f "delims=" %%p in (\'where node 2^>nul\') do if not defined NODE_EXE set "NODE_EXE=%%p"',
    'if defined NODE_EXE goto :eof',
    '',
    ':ensure_cached',
    'rem 2) the portable copy an earlier run installed',
    'if exist "%NODE_CACHED%" set "NODE_EXE=%NODE_CACHED%"',
    'if defined NODE_EXE goto :eof',
    'rem 3) nothing usable: fetch one',
    'call :install_node',
    'goto :eof',
    '',
    ':accept_ver',
    'rem %1 = output of `node -v`, e.g. v24.22.2. Sets NODE_OK when it is >= 18.',
    'set "MAJOR=%~1"',
    'for /f "tokens=1 delims=." %%a in ("%MAJOR:~1%") do set "MAJOR=%%a"',
    'echo %MAJOR%|findstr /r /c:"^[0-9][0-9]*$" >nul',
    'if errorlevel 1 goto :eof',
    'if %MAJOR% LSS 18 goto :eof',
    'set "NODE_OK=1"',
    'goto :eof',
    '',
    ':install_node',
    'echo.',
    'echo Node.js 18+ was not found on this machine.',
    'echo Downloading a portable copy ^(about 36 MB, one time only^) to',
    'echo   %NODE_HOME%',
    'echo No administrator rights needed. Press Ctrl+C to cancel, or wait.',
    'echo.',
    'if not exist "%NODE_HOME%" mkdir "%NODE_HOME%" >nul 2>nul',
    'set "NODE_ZIP=%TEMP%\\weauto-%NODE_PKG%.zip"',
    'del "%NODE_ZIP%" >nul 2>nul',
    'rem Mirror first on purpose: nodejs.org runs at tens of KB/s from mainland',
    'rem China, and a 36 MB download looks like a hang to whoever is waiting.',
    'call :download "https://npmmirror.com/mirrors/node/%NODE_VER%/%NODE_PKG%.zip" "%NODE_ZIP%"',
    'if not exist "%NODE_ZIP%" call :download "https://nodejs.org/dist/%NODE_VER%/%NODE_PKG%.zip" "%NODE_ZIP%"',
    'if not exist "%NODE_ZIP%" goto :eof',
    '',
    'echo Extracting...',
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Expand-Archive -LiteralPath '%NODE_ZIP%' -DestinationPath '%NODE_HOME%' -Force; exit 0 } catch { exit 1 }"`,
    'if exist "%NODE_CACHED%" goto :install_done',
    'rem Expand-Archive needs PowerShell 5; bsdtar ships with Win10 1803+',
    'tar.exe -xf "%NODE_ZIP%" -C "%NODE_HOME%" >nul 2>nul',
    '',
    ':install_done',
    'del "%NODE_ZIP%" >nul 2>nul',
    'if not exist "%NODE_CACHED%" echo Could not extract the archive.',
    'if not exist "%NODE_CACHED%" goto :eof',
    'rem A half-written or AV-rewritten archive extracts but will not run;',
    'rem wipe it so the next attempt starts clean instead of reusing garbage.',
    '"%NODE_CACHED%" -v >nul 2>nul',
    'if not errorlevel 1 goto :node_ready',
    'rmdir /s /q "%NODE_HOME%" >nul 2>nul',
    'goto :eof',
    '',
    ':node_ready',
    'set "NODE_EXE=%NODE_CACHED%"',
    'goto :eof',
    '',
    ':download',
    'rem %1 = url, %2 = target file. On failure the file is removed so the',
    'rem caller can try the next source instead of shipping a partial zip.',
    'set "DL_OUT=%~2"',
    'del "%DL_OUT%" >nul 2>nul',
    'where curl.exe >nul 2>nul',
    'if errorlevel 1 goto :download_ps',
    'curl.exe -fL --retry 2 --connect-timeout 20 --progress-bar -o "%DL_OUT%" "%~1"',
    'if not errorlevel 1 if exist "%DL_OUT%" goto :eof',
    'del "%DL_OUT%" >nul 2>nul',
    '',
    ':download_ps',
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -UseBasicParsing -Uri '%~1' -OutFile '%DL_OUT%'; exit 0 } catch { exit 1 }"`,
    'if not errorlevel 1 if exist "%DL_OUT%" goto :eof',
    'del "%DL_OUT%" >nul 2>nul',
    'goto :eof',
    '',
  ];

  // CRLF：cmd.exe 对纯 LF 的批处理在某些版本上会解析出错
  return lines.join('\r\n');
}
