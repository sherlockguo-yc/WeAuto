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
 * 凭据组清单：一个组 = 同一个站点、同一把钥匙的一组模板。
 *
 * 账号按组归属（不是按模板）：WorkBuddy 的签到与活跃同属 `workbuddy`，
 * 所以「一个 WorkBuddy 账号」只存一份 WB_ACCESS_TOKEN，两个任务引用它即可。
 *
 * 组的字段集合 = 组内所有模板 `requires` 的并集。账号表单要一次把整组字段填完，
 * 否则用户在签到页建的账号拿到活跃任务上会缺字段。
 *
 * 只聚合同组、不按字段名猜——两个不相干站点都用 `TOKEN` 这种字段名很常见，
 * 合到一起会写错值，而失败现象是「鉴权失败」，排查时根本想不到是凭据串了。
 *
 * @param {Map<string, object>} tasks 已规范化任务
 * @returns {{group: string, label: string, fields: string[], taskNames: string[]}[]}
 */
export function credentialGroups(tasks) {
  const map = new Map();
  for (const [name, task] of tasks) {
    const requires = task.requires ?? [];
    // 不需要凭据的模板不构成组：给它建账号是无意义的空表单
    if (!requires.length) continue;
    // 不写 credentialGroup = 自成一组（契约默认值，与 normalizeTask 一致）
    const group = task.credentialGroup ?? task.name;
    let g = map.get(group);
    if (!g) {
      g = { group, label: '', names: [], fields: [], taskNames: [] };
      map.set(group, g);
    }
    g.taskNames.push(name);
    if (!g.names.includes(task.displayName)) g.names.push(task.displayName);
    for (const f of requires) if (!g.fields.includes(f)) g.fields.push(f);
  }
  const out = [];
  for (const g of map.values()) {
    out.push({
      group: g.group,
      // 组的可读名用组内模板名，用户认得出「这是 WorkBuddy」
      label: g.names.join(' / '),
      fields: g.fields,
      taskNames: g.taskNames,
    });
  }
  return out.sort((a, b) => a.group.localeCompare(b.group));
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
