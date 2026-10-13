/**
 * 任务注册表 —— 扫描 tasks/ 目录，加载全部任务定义
 *
 * 新增任务 = 在 tasks/ 放一个 .mjs 文件导出 default 任务对象，无需改任何框架代码。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, hhmmToSeconds } from './util.mjs';

export const TASKS_DIR = path.join(ROOT, 'tasks');

/** 24 小时制的 HH:MM */
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * 校验任务定义，不合法即抛错。
 *
 * 校验全部前移到加载期：任务定义写错应在 `weauto list` 时就报出来，
 * 而不是等到当天窗口触发、真去执行时才发现（排查成本高得多）。
 *
 * @param {any} task 任务对象
 * @param {string} file 来源文件名，仅用于错误信息
 */
export function assertValidTask(task, file) {
  if (!task || typeof task !== 'object') {
    throw new Error(`任务文件 ${file} 未导出 default 对象`);
  }
  if (typeof task.name !== 'string' || !task.name) {
    throw new Error(`任务文件 ${file} 缺少 name 字段`);
  }
  if (typeof task.run !== 'function') {
    throw new Error(`任务 ${task.name} 缺少 run 函数`);
  }
  if (task.displayName !== undefined && typeof task.displayName !== 'string') {
    throw new Error(`任务 ${task.name} 的 displayName 必须是字符串`);
  }
  if (task.requires !== undefined) {
    const bad =
      !Array.isArray(task.requires) ||
      task.requires.some((k) => typeof k !== 'string' || !k);
    if (bad) {
      throw new Error(`任务 ${task.name} 的 requires 必须是非空字符串数组`);
    }
  }

  const window = task.schedule?.window;
  if (window) {
    for (const key of ['start', 'end']) {
      const value = window[key];
      if (!HHMM_RE.test(String(value ?? ''))) {
        throw new Error(
          `任务 ${task.name} 的 schedule.window.${key} 必须是 HH:MM 格式（当前 ${JSON.stringify(value)}）`,
        );
      }
    }
    if (hhmmToSeconds(window.end) <= hhmmToSeconds(window.start)) {
      throw new Error(
        `任务 ${task.name} 的调度窗口非法：${window.start}–${window.end}（结束须晚于开始）`,
      );
    }
  }
}

/** 加载全部任务，返回 Map<name, task> */
export async function loadTasks() {
  const tasks = new Map();
  if (!fs.existsSync(TASKS_DIR)) return tasks;

  const files = fs
    .readdirSync(TASKS_DIR)
    .filter((f) => f.endsWith('.mjs'))
    .sort();

  for (const file of files) {
    let mod;
    try {
      mod = await import(pathToFileURL(path.join(TASKS_DIR, file)).href);
    } catch (err) {
      // 任务文件本身有语法/导入错误时，给出「哪个文件坏了」而不是一坨堆栈
      throw new Error(`加载任务文件 tasks/${file} 失败：${err.message}`);
    }
    const task = mod.default;
    assertValidTask(task, file);
    if (tasks.has(task.name)) {
      throw new Error(`任务名重复：${task.name}（来自 ${file}）`);
    }
    tasks.set(task.name, { ...task, file });
  }
  return tasks;
}

/** 按名称取任务，不存在时报出可用列表 */
export async function getTask(name) {
  const tasks = await loadTasks();
  const task = tasks.get(name);
  if (!task) {
    const available = [...tasks.keys()].join(', ') || '(无)';
    throw new Error(`未知任务 "${name}"，可用任务：${available}`);
  }
  return task;
}
