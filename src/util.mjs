/**
 * 通用工具：路径常量、环境解析、时区计算
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const RUNS_FILE = path.join(DATA_DIR, 'runs.jsonl');
export const LOCK_FILE = path.join(DATA_DIR, '.lock');
export const SECRETS_FILE = path.join(ROOT, 'secrets.age');

/**
 * 统一用北京时间判断调度窗口。
 * 显式指定时区，避免任务行为随运行环境的系统时区漂移。
 */
export const TZ = 'Asia/Shanghai';

export const AGE_KEY_FILE =
  process.env.WEAUTO_AGE_KEY || path.join(process.env.HOME || '', '.age', 'weauto.key');

export function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** 解析 KEY=VALUE 文本（.env 或 age 解密输出） */
export function parseDotenv(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** 指定时区下的日期字符串 YYYY-MM-DD */
export function dateInTZ(d = new Date(), tz = TZ) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** 指定时区下自当日 00:00 起的秒数 */
export function secondsOfDayInTZ(d = new Date(), tz = TZ) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const pick = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return pick('hour') * 3600 + pick('minute') * 60 + pick('second');
}

/** 指定时区下的可读时间戳，用于日志与展示 */
export function timestampInTZ(d = new Date(), tz = TZ) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
    .format(d)
    .replace('T', ' ');
}

/** "HH:MM" → 自午夜起的秒数 */
export function hhmmToSeconds(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm).trim());
  if (!m) throw new Error(`非法的 HH:MM 格式: ${hhmm}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60;
}

/** 秒数 → "HH:MM" */
export function secondsToHHMM(sec) {
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * 'YYYY-MM-DD'（北京时间）当日 00:00 的 epoch ms
 * 用来把「当天的第几秒」换算成绝对时刻。
 */
export function startOfDayBeijingMs(date) {
  const t = Date.parse(`${date}T00:00:00+08:00`);
  if (Number.isNaN(t)) throw new Error(`非法日期：${date}`);
  return t;
}

/**
 * 解析调度用的时刻。
 *
 * 接受两种写法，**都不产生歧义**：
 *   · `YYYY-MM-DD HH:MM[:SS]` → 按北京时间（UTC+8）解释，与本项目的时区口径一致
 *   · 带显式时区的 ISO 字符串（结尾是 Z 或 ±HH:MM）→ 按写明的时区解释
 *
 * 刻意不接受「只有年月日」或「斜杠分隔」的写法：调度时刻写错会导致任务在
 * 意料之外的时间执行，宁可让它在这里报错。
 *
 * @returns {number} epoch ms
 */
export function parseScheduleTime(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error(`时间必须是字符串，当前是 ${JSON.stringify(input)}`);
  }
  const s = input.trim();

  if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(s)) {
    const t = Date.parse(s);
    if (Number.isNaN(t)) throw new Error(`无法解析时间：${input}`);
    return t;
  }

  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) {
    throw new Error(
      `时间格式应为「YYYY-MM-DD HH:MM」（北京时间）或带时区的 ISO 字符串，当前是：${input}`,
    );
  }
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}+08:00`);
  if (Number.isNaN(t)) throw new Error(`无法解析时间：${input}`);
  return t;
}

/** 人类可读的时长 */
export function humanDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
}
