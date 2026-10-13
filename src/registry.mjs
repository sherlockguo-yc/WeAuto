/**
 * 任务注册表 —— 扫描 tasks/ 目录，加载全部任务定义
 *
 * 新增任务 = 在 tasks/ 放一个 .mjs 文件导出 default 任务对象，无需改任何框架代码。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './util.mjs';

export const TASKS_DIR = path.join(ROOT, 'tasks');

function assertValidTask(task, file) {
  if (!task || typeof task !== 'object') {
    throw new Error(`任务文件 ${file} 未导出 default 对象`);
  }
  if (typeof task.name !== 'string' || !task.name) {
    throw new Error(`任务文件 ${file} 缺少 name 字段`);
  }
  if (typeof task.run !== 'function') {
    throw new Error(`任务 ${task.name} 缺少 run 函数`);
  }
  if (task.schedule?.window) {
    const { start, end } = task.schedule.window;
    if (!start || !end) {
      throw new Error(`任务 ${task.name} 的 schedule.window 需要 start 与 end`);
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
    const mod = await import(pathToFileURL(path.join(TASKS_DIR, file)).href);
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
