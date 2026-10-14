/**
 * 任务契约 —— 任务文件的形状与语义
 *
 * 设计意图见 docs/requirements/weauto-contract.md。核心判据：
 * **新增一个任务，需要改动的文件只能有那个任务文件本身。**
 *
 * 本模块是契约的唯一权威：状态取值、view 词表、默认值、校验规则都在这里，
 * 其它模块（注册表、执行器、调度器、HTTP 接口）一律从这里取，不各自复制一份。
 *
 * 两条贯穿全文件的规则：
 *   1. **结构错误在加载期抛错**：任务定义写错要在 `weauto list` 时就报出来，
 *      而不是等到当天触发、真去执行时才发现（那时排查成本高得多）。
 *   2. **未知语义保守降级**：框架不认识的 view type 不报错、不崩，交给渲染层
 *      按 text 兜底，并把原值放进「原始数据」区。这样新增类型不要求框架先升级。
 */
import { hhmmToSeconds, parseScheduleTime, timestampInTZ } from './util.mjs';

/* ─────────────────── 状态 ─────────────────── */

/**
 * 执行状态。**取值必须与已上线的 CLI 记录、WeMonitor 面板保持一致**：
 * 改名字会同时打断正在跑的 cron 记录与消费方面板。
 * （`already-signed` 是站点特定措辞，等 WeMonitor 面板在 P4 摘除后可改为中性的 `already-done`。）
 */
export const STATUS = {
  SUCCESS: 'success',
  ALREADY: 'already-signed',
  SKIPPED: 'skipped',
  FAILED: 'failed',
  BLOCKED: 'blocked',
  NETWORK: 'network-error',
  CONFIG: 'config-error',
};

/** 视为「今天这件事已经办成了」——幂等判断与统计口径都用它 */
export const SUCCESS_STATUSES = new Set([STATUS.SUCCESS, STATUS.ALREADY]);

export function isSuccess(status) {
  return SUCCESS_STATUSES.has(status);
}

export const ALL_STATUSES = Object.values(STATUS);

/* ─────────────────── view（结果展示声明） ─────────────────── */

/** 类型词表，保持小而可扩展 */
export const VIEW_TYPES = Object.freeze([
  'text',
  'number',
  'bytes',
  'percent',
  'date',
  'datetime',
  'duration',
  'bool',
  'list',
  'json',
]);

export const DEFAULT_VIEW_TYPE = 'text';

/** 未知类型返回 false，由渲染层按 text 兜底（不报错，见文件头规则 2） */
export function isKnownViewType(type) {
  return VIEW_TYPES.includes(type);
}

/* ─────────────────── 默认值与上限 ─────────────────── */

export const DEFAULT_TIMEOUT_MS = 60_000;
/** 上限不是为了限制业务，而是防止把手滑写成的数字变成「永远不结束的任务」 */
export const MAX_TIMEOUT_MS = 30 * 60_000;

export const DEFAULT_RETENTION = Object.freeze({ days: 90, maxRows: 2000, logDays: 30 });

/** 任务名会进 URL 与数据库，必须限定字符集（与 WeMonitor 侧的白名单一致） */
export const TASK_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/* ─────────────────── 校验 ─────────────────── */

function bad(msg) {
  throw new Error(msg);
}

function normalizeView(taskName, view) {
  if (view === undefined) return [];
  if (!Array.isArray(view)) bad(`任务 ${taskName} 的 view 必须是数组`);

  return view.map((entry, i) => {
    const where = `任务 ${taskName} 的 view[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      bad(`${where} 必须是对象，形如 { key, label, type }`);
    }
    if (typeof entry.key !== 'string' || !entry.key) bad(`${where} 缺少 key`);
    if (entry.label !== undefined && typeof entry.label !== 'string') {
      bad(`${where} 的 label 必须是字符串`);
    }
    if (entry.type !== undefined && typeof entry.type !== 'string') {
      bad(`${where} 的 type 必须是字符串`);
    }
    // type 允许未知值：结构合法即可，语义未知交给渲染层兜底
    return { key: entry.key, label: entry.label ?? entry.key, type: entry.type ?? DEFAULT_VIEW_TYPE };
  });
}

function normalizeRetention(taskName, retention) {
  if (retention === undefined) return { ...DEFAULT_RETENTION };
  if (!retention || typeof retention !== 'object' || Array.isArray(retention)) {
    bad(`任务 ${taskName} 的 retention 必须是对象，形如 { days, maxRows }`);
  }
  const out = { ...DEFAULT_RETENTION };
  for (const key of ['days', 'maxRows', 'logDays']) {
    if (retention[key] === undefined) continue;
    const v = retention[key];
    if (!Number.isInteger(v) || v <= 0) bad(`任务 ${taskName} 的 retention.${key} 必须是正整数`);
    out[key] = v;
  }
  return out;
}

/**
 * 调度声明。
 *
 * **`undefined` / `null` = 不自动执行，只能手动触发。**
 * 这是刻意的安全默认：常驻调度器里「没有调度」若解释成「每次都执行」，
 * 会得到一个永不停止的任务。CLI 时代没有这个风险（每次都靠 cron 触发），
 * 服务化之后必须显式。
 */
function normalizeSchedule(taskName, schedule) {
  if (schedule === undefined || schedule === null) return null;
  if (typeof schedule !== 'object' || Array.isArray(schedule)) {
    bad(`任务 ${taskName} 的 schedule 必须是对象`);
  }

  // 顶层未知字段允许保留（无害的装饰），但 schedule 里的未知字段必须报错：
  // 那意味着任务想表达一种框架不认识的调度方式 —— 静默忽略会变成
  // 「配置看着没问题，任务却永远不执行」，是最难排查的一类故障。
  const allowed = ['window', 'once', 'every'];
  const unknown = Object.keys(schedule).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    bad(
      `任务 ${taskName} 的 schedule 含未知字段：${unknown.join(', ')}（允许 window / once / every）`,
    );
  }

  const present = allowed.filter((k) => schedule[k] !== undefined);
  if (present.length === 0) {
    bad(`任务 ${taskName} 的 schedule 是空对象：要么去掉它（= 只能手动触发），要么声明一种调度方式`);
  }
  if (present.length > 1) {
    bad(`任务 ${taskName} 的 schedule 同时声明了 ${present.join(' / ')}：只能选一种`);
  }

  if (schedule.every !== undefined) {
    const e = schedule.every;
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      bad(`任务 ${taskName} 的 schedule.every 必须是对象 { minutes }`);
    }
    const extra = Object.keys(e).filter((k) => !['minutes', 'jitterSec'].includes(k));
    if (extra.length) {
      bad(`任务 ${taskName} 的 schedule.every 含未知字段：${extra.join(', ')}`);
    }
    if (!Number.isInteger(e.minutes) || e.minutes < 1) {
      bad(`任务 ${taskName} 的 schedule.every.minutes 必须是不小于 1 的整数`);
    }
    let jitterSec = 0;
    if (e.jitterSec !== undefined) {
      if (!Number.isInteger(e.jitterSec) || e.jitterSec < 0) {
        bad(`任务 ${taskName} 的 schedule.every.jitterSec 必须是非负整数`);
      }
      // 抖动必须小于间隔本身，否则触发时刻会漂到「上一轮」之后，间隔名不副实
      if (e.jitterSec >= e.minutes * 60) {
        bad(`任务 ${taskName} 的 schedule.every.jitterSec 必须小于间隔本身（${e.minutes * 60}s）`);
      }
      jitterSec = e.jitterSec;
    }
    return { kind: 'every', every: { minutes: e.minutes, jitterSec } };
  }

  if (schedule.once !== undefined) {
    const o = schedule.once;
    if (!o || typeof o !== 'object' || Array.isArray(o)) {
      bad(`任务 ${taskName} 的 schedule.once 必须是对象 { at }`);
    }
    const extra = Object.keys(o).filter((k) => k !== 'at');
    if (extra.length) {
      bad(`任务 ${taskName} 的 schedule.once 含未知字段：${extra.join(', ')}`);
    }
    // 解析期就失败，不要等到调度时才发现写错
    const atMs = parseScheduleTime(o.at);
    return { kind: 'once', once: { atMs, atLabel: timestampInTZ(new Date(atMs)) } };
  }

  const window = schedule.window;
  if (window) {
    if (typeof window !== 'object' || Array.isArray(window)) {
      bad(`任务 ${taskName} 的 schedule.window 必须是对象 { start, end }`);
    }
    for (const key of ['start', 'end']) {
      const value = window[key];
      if (!HHMM_RE.test(String(value ?? ''))) {
        bad(
          `任务 ${taskName} 的 schedule.window.${key} 必须是 HH:MM 格式（当前 ${JSON.stringify(value)}）`,
        );
      }
    }
    if (hhmmToSeconds(window.end) <= hhmmToSeconds(window.start)) {
      bad(`任务 ${taskName} 的调度窗口非法：${window.start}–${window.end}（结束须晚于开始）`);
    }
    return { kind: 'window', window: { start: window.start, end: window.end } };
  }

  // present.length === 1 已保证三种类型必有其一，且 every / once 都已提前返回，
  // 所以正常情况到不了这里。保留显式报错（而不是 return null）：将来新增调度类型时
  // 若漏改分支，会立刻炸出来，而不是静默变成「永远不执行」。
  bad(`任务 ${taskName} 的 schedule 无法识别：${JSON.stringify(schedule)}`);
}

/**
 * 校验任务定义。不合法即抛错；不返回任何东西（规范化见 normalizeTask）。
 * @param {any} task
 * @param {string} file 来源文件名，仅用于错误信息
 */
export function assertValidTask(task, file) {
  if (!task || typeof task !== 'object') {
    bad(`任务文件 ${file} 未导出 default 对象`);
  }
  if (typeof task.name !== 'string' || !task.name) {
    bad(`任务文件 ${file} 缺少 name 字段`);
  }
  if (!TASK_NAME_RE.test(task.name)) {
    bad(`任务 ${task.name} 的 name 非法：只允许小写字母、数字与连字符（如 v2free-checkin）`);
  }
  if (typeof task.run !== 'function') {
    bad(`任务 ${task.name} 缺少 run 函数`);
  }
  if (task.displayName !== undefined && typeof task.displayName !== 'string') {
    bad(`任务 ${task.name} 的 displayName 必须是字符串`);
  }
  if (task.description !== undefined && typeof task.description !== 'string') {
    bad(`任务 ${task.name} 的 description 必须是字符串`);
  }
  if (task.group !== undefined && (typeof task.group !== 'string' || !task.group)) {
    bad(`任务 ${task.name} 的 group 必须是非空字符串`);
  }
  if (task.tags !== undefined) {
    const ok = Array.isArray(task.tags) && task.tags.every((t) => typeof t === 'string' && t);
    if (!ok) bad(`任务 ${task.name} 的 tags 必须是非空字符串数组`);
  }
  if (task.requires !== undefined) {
    const invalid =
      !Array.isArray(task.requires) || task.requires.some((k) => typeof k !== 'string' || !k);
    if (invalid) bad(`任务 ${task.name} 的 requires 必须是非空字符串数组`);
  }
  if (task.accounts !== undefined && typeof task.accounts !== 'boolean') {
    bad(`任务 ${task.name} 的 accounts 必须是布尔值`);
  }
  if (task.timeoutMs !== undefined) {
    if (!Number.isInteger(task.timeoutMs) || task.timeoutMs <= 0) {
      bad(`任务 ${task.name} 的 timeoutMs 必须是正整数`);
    }
    if (task.timeoutMs > MAX_TIMEOUT_MS) {
      bad(`任务 ${task.name} 的 timeoutMs 超过上限 ${MAX_TIMEOUT_MS}ms`);
    }
  }

  normalizeSchedule(task.name, task.schedule);
  normalizeView(task.name, task.view);
  normalizeRetention(task.name, task.retention);
}

/* ─────────────────── 规范化 ─────────────────── */

/**
 * 补默认值并规范化，返回新的任务对象。
 *
 * **保留未知字段**：框架不认识的顶层字段原样带着，不删除、不报错 ——
 * 这样任务可以先写将来才会用到的字段，不会因为框架版本旧就加载失败。
 *
 * @param {any} task 已通过校验的原始任务对象
 * @param {string} file 来源文件名
 */
export function normalizeTask(task, file) {
  assertValidTask(task, file);
  return {
    ...task,
    file,
    name: task.name,
    displayName: task.displayName ?? task.name,
    description: task.description ?? null,
    group: task.group ?? '未分组',
    tags: task.tags ? [...task.tags] : [],
    requires: task.requires ? [...task.requires] : [],
    accounts: task.accounts ?? false,
    timeoutMs: task.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    retention: normalizeRetention(task.name, task.retention),
    schedule: normalizeSchedule(task.name, task.schedule),
    view: normalizeView(task.name, task.view),
  };
}

/**
 * 供接口/CLI 输出的任务摘要。
 * 只输出可安全外传的字段：**绝不包含 run 函数**（函数无法序列化，也容易顺手泄漏内部实现）。
 */
export function describeTask(task) {
  return {
    name: task.name,
    displayName: task.displayName,
    description: task.description,
    group: task.group,
    tags: task.tags,
    requires: task.requires,
    accounts: task.accounts,
    timeoutMs: task.timeoutMs,
    retention: task.retention,
    schedule: task.schedule,
    view: task.view,
    file: task.file ?? null,
  };
}
