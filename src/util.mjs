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

/** 人类可读的时长 */
export function humanDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
}
