/**
 * 结果字段的展示格式化 —— 契约里 `view` 的类型词表的实现
 *
 * 两条硬规则：
 *   1. **未知类型按 text 渲染**，不报错。这样任务可以用框架还不认识的新类型，
 *      界面不会因为「版本旧」而整页报错（契约里承诺的向前兼容落在这里）。
 *   2. **解析失败回退为原值**。日期字段拿到一个不认识的字符串时必须原样显示，
 *      绝不能出现 `Invalid Date` —— 那等于把「站点改版」伪装成「界面坏了」。
 */
import { humanDuration } from './util.mjs';

export const MISSING = '—';

function isEmpty(v) {
  return v === null || v === undefined || v === '';
}

/** 字节数的可读化。站点返回的通常是字节整数 */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n)) return String(bytes);
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = Math.abs(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  // 小于 10 时给一位小数，否则取整：1.5 GB 有意义，999.5 MB 没意义
  const digits = v < 10 && i > 0 ? 1 : 0;
  return `${n < 0 ? '-' : ''}${v.toFixed(digits)} ${units[i]}`;
}

/** 尽量把各种写法解析成时间；解析不了返回 null */
export function parseAnyDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  if (typeof value === 'number' && Number.isFinite(value)) {
    // 10 位当秒、13 位当毫秒：面板常见的两种时间戳写法
    const ms = value < 1e11 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  if (typeof value === 'string' && value.trim()) {
    const s = value.trim();
    // 'YYYY-MM-DD HH:MM[:SS]' 在 Node 里解析不稳定，显式按北京时间补齐
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
    const normalized = m
      ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}+08:00`
      : s;
    const t = Date.parse(normalized);
    return Number.isNaN(t) ? null : new Date(t);
  }

  return null;
}

/** 北京时间的 YYYY-MM-DD / YYYY-MM-DD HH:MM:SS */
export function formatDate(value, { withTime = false } = {}) {
  const d = parseAnyDate(value);
  if (!d) return typeof value === 'string' ? value : String(value ?? MISSING);
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false } : {}),
  }).format(d);
  return withTime ? parts.replace('T', ' ') : parts;
}

export function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

/**
 * 按契约里的 type 渲染单个值。
 * @param {string} type view 里声明的类型（可能是框架不认识的）
 * @param {any} value
 * @returns {string} 一定是可安全放进 HTML 文本节点的字符串（转义由渲染层负责）
 */
export function formatValue(type, value) {
  if (isEmpty(value)) return MISSING;

  switch (type) {
    case 'bytes':
      return formatBytes(value);
    case 'number':
      return formatNumber(value);
    case 'percent': {
      const n = Number(value);
      if (!Number.isFinite(n)) return String(value);
      // 站点可能返回 0.87 也可能返回 87，两种都见得到
      return `${formatNumber(n <= 1 ? n * 100 : n)}%`;
    }
    case 'date':
      return formatDate(value);
    case 'datetime':
      return formatDate(value, { withTime: true });
    case 'duration': {
      const n = Number(value);
      // 大于一天的毫秒数更可能是「秒」，交给 humanDuration 处理毫秒
      return Number.isFinite(n) ? humanDuration(n) : String(value);
    }
    case 'bool':
      return value === true || value === 1 || value === '1' ? '是' : '否';
    case 'list':
      return Array.isArray(value) ? value.map((v) => String(v)).join('、') : String(value);
    case 'json':
      return typeof value === 'string' ? value : JSON.stringify(value);
    case 'text':
    case undefined:
    case null:
      return String(value);
    default:
      // 未知类型：按 text 处理（契约里承诺的向前兼容）
      return typeof value === 'string' ? value : JSON.stringify(value);
  }
}

/**
 * 把一次运行的 data 按 view 声明渲染成 [{label, value, raw}]。
 *
 * 未在 view 里声明的字段**不会丢**：一并返回在 remaining 里（它们已经落库，
 * 排查时可直接查历史记录）。当前页面只渲染声明过的字段，remaining 留给调用方
 * 按需使用——面板要的信息越少越好读。
 */
export function renderView(view, data) {
  const declared = new Set(view.map((v) => v.key));
  const rows = view.map((v) => ({
    key: v.key,
    label: v.label,
    value: formatValue(v.type, data?.[v.key]),
    missing: isEmpty(data?.[v.key]),
  }));
  const remaining = Object.entries(data ?? {})
    .filter(([k]) => !declared.has(k))
    .map(([k, v]) => ({ key: k, value: typeof v === 'string' ? v : JSON.stringify(v) }));
  return { rows, remaining };
}
