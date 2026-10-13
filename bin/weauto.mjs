#!/usr/bin/env node
/**
 * WeAuto CLI
 *
 *   weauto run <task> [--force]   执行任务（供 crontab 调用）
 *   weauto list                   列出全部已注册任务
 *   weauto status [--json]        查看执行记录
 *
 * 退出码：0 = 成功或正常跳过；1 = 失败
 */
import { isSuccess, readRuns } from '../src/history.mjs';
import { loadTasks } from '../src/registry.mjs';
import { STATUS, runTask } from '../src/runner.mjs';
import { describeWindow } from '../src/schedule.mjs';

const USAGE = `WeAuto —— 通用自动化任务框架

用法：
  weauto run <task> [--force]   执行任务（--force 忽略调度窗口与幂等，立即执行）
  weauto list                   列出全部已注册任务
  weauto status [--json]        查看最近执行记录

示例：
  weauto run v2free-checkin
  weauto run v2free-checkin --force
  weauto status`;

function parseArgs(argv) {
  return {
    flags: new Set(argv.filter((a) => a.startsWith('--'))),
    positional: argv.filter((a) => !a.startsWith('--')),
  };
}

async function cmdRun(positional, flags) {
  const taskName = positional[0];
  if (!taskName) {
    console.error('用法：weauto run <task> [--force]');
    process.exit(1);
  }
  const record = await runTask(taskName, { force: flags.has('--force') });
  const ok = isSuccess(record.status) || record.status === STATUS.SKIPPED;
  process.exit(ok ? 0 : 1);
}

async function cmdList() {
  const tasks = await loadTasks();
  if (!tasks.size) {
    console.log('（tasks/ 下没有已注册任务）');
    return;
  }
  for (const t of tasks.values()) {
    const w = t.schedule?.window;
    console.log(`• ${t.name}`);
    console.log(`    名称 : ${t.displayName ?? '—'}`);
    if (w) {
      const d = describeWindow(t.name, w);
      console.log(`    窗口 : ${w.start}–${w.end}（今日目标 ${d.targetLabel}，还有 ${d.remaining}）`);
    } else {
      console.log('    窗口 : 不设窗口（每次触发都执行）');
    }
    console.log(`    凭据 : ${(t.requires ?? []).join(', ') || '—'}`);
    console.log(`    文件 : tasks/${t.file ?? '?'}`);
  }
}

async function cmdStatus(flags) {
  const runs = readRuns(200);
  if (flags.has('--json')) {
    console.log(JSON.stringify({ last: runs[0] ?? null, runs: runs.slice(0, 50) }, null, 2));
    return;
  }
  if (!runs.length) {
    console.log('（暂无执行记录）');
    return;
  }
  for (const r of runs.slice(0, 20)) {
    const mark = isSuccess(r.status) ? '✓' : r.status === 'skipped' ? '·' : '✗';
    console.log(
      `${mark} ${r.time ?? ''}  ${String(r.task).padEnd(18)} ${String(r.status).padEnd(14)} ${r.message ?? ''}`,
    );
  }
}

const [, , cmd, ...rest] = process.argv;
const { flags, positional } = parseArgs(rest);

switch (cmd) {
  case 'run':
    await cmdRun(positional, flags);
    break;
  case 'list':
    await cmdList();
    break;
  case 'status':
    await cmdStatus(flags);
    break;
  case undefined:
  case '-h':
  case '--help':
    console.log(USAGE);
    break;
  default:
    console.error(`未知命令：${cmd}\n`);
    console.log(USAGE);
    process.exit(1);
}
