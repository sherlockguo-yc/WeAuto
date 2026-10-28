/**
 * 任务注册表 —— 扫描 tasks/ 目录，加载全部任务定义
 *
 * 新增任务 = 在 tasks/ 放一个 .mjs 文件导出 default 任务对象，无需改任何框架代码。
 * 任务对象的形状与语义由 src/task-contract.mjs 定义（契约的唯一权威）：
 * 校验与规范化都在那里，本模块只负责「发现与加载」这一件事。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './util.mjs';
import { assertValidTask, normalizeTask } from './task-contract.mjs';

export const TASKS_DIR = path.join(ROOT, 'tasks');

// 兼容既有调用点与测试：校验的具体规则已移到契约模块
export { assertValidTask };

/**
 * 加载全部任务（已规范化），返回 Map<name, task>
 *
 * 校验全部前移到加载期：任务定义写错应在 `weauto list` 时就报出来，
 * 而不是等到当天窗口触发、真去执行时才发现（排查成本高得多）。
 */
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
    const task = normalizeTask(mod.default, file);
    if (tasks.has(task.name)) {
      throw new Error(`任务名重复：${task.name}（来自 ${file}）`);
    }
    tasks.set(task.name, task);
  }
  return tasks;
}

/**
 * 同一个凭据组里的**其它**模板名。
 *
 * 用途：用户只在一处填过 token 时，让同组的另一个任务也能跑起来
 * （WorkBuddy 的签到与活跃就是同一把 WB_ACCESS_TOKEN）。
 *
 * 只返回「组名相同」的兄弟，不按字段名猜——两个不相干站点都用 `TOKEN`
 * 这种字段名很常见，跨组兜底会拿到错的值，而且失败现象是「鉴权失败」，
 * 排查时根本想不到是凭据串了。
 *
 * @param {Map<string, object>} tasks 已规范化任务
 * @param {string} taskName
 * @returns {string[]}
 */
export function credentialPeers(tasks, taskName) {
  const self = tasks.get(taskName);
  if (!self) return [];
  const out = [];
  for (const [name, task] of tasks) {
    if (name === taskName) continue;
    if (task.credentialGroup === self.credentialGroup) out.push(name);
  }
  return out;
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
