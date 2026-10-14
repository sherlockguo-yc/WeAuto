#!/usr/bin/env node
/**
 * 把命令行时代的历史（data/runs.jsonl）导入 SQLite（一次性）
 *
 *   node scripts/import-runs.mjs            # 预演，只打印将要导入什么
 *   node scripts/import-runs.mjs --apply    # 真正导入
 *
 * 幂等：以「任务 + 时间戳」为唯一键，重复执行不会导入两份。
 * 换句话说，这个脚本可以安全地多跑几次。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pickOwnerId } from '../src/bootstrap.mjs';
import { openDb } from '../src/db.mjs';
import { createStore } from '../src/store.mjs';
import { RUNS_FILE } from '../src/util.mjs';

const apply = process.argv.includes('--apply');

function readJsonl(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* 跳过损坏行 */
    }
  }
  return out;
}

const db = openDb();
const store = createStore(db);

// 多租户后每条记录都必须有归属，历史的归属就是第一个账号
const ownerId = Number(process.env.WEAUTO_OWNER_ID) || pickOwnerId(db);
if (!ownerId) {
  console.error('库里还没有任何账号：请先创建管理员，或用 WEAUTO_OWNER_ID 指定归属');
  process.exit(1);
}
const mine = store.forUser(ownerId);
console.log(`历史记录将归入账号 ${ownerId}`);

const rows = readJsonl(RUNS_FILE);
if (!rows.length) {
  console.log(`没有历史记录（${RUNS_FILE} 不存在或为空）`);
  process.exit(0);
}

// 命令行时代的 ts 是秒，数据库用毫秒；date 已是北京时间的日期
const records = rows.map((r) => ({
  taskName: r.task,
  date: r.date ?? null,
  ts: Number(r.ts) < 1e11 ? Number(r.ts) * 1000 : Number(r.ts),
  status: r.status,
  message: r.message ?? '',
  data: r.data ?? null,
  dur: Number(r.dur ?? 0),
  trigger: r.force ? 'manual' : 'schedule',
}));

console.log(`读取到 ${records.length} 条历史记录`);
const byStatus = {};
for (const r of records) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
console.log('按状态:', JSON.stringify(byStatus));
if (records.length) {
  console.log(
    '时间范围:',
    new Date(Math.min(...records.map((r) => r.ts))).toISOString(),
    '→',
    new Date(Math.max(...records.map((r) => r.ts))).toISOString(),
  );
}

if (!apply) {
  console.log('\n[dry-run] 未写入数据库。确认无误后加 --apply');
  process.exit(0);
}

// 先把库里已有的「任务+时间戳」收集起来，避免重复导入
const seen = new Set();
for (const name of new Set(records.map((r) => r.taskName))) {
  for (const r of mine.runsOfTask(name, { limit: 100000 })) seen.add(`${r.task}@${r.ts}`);
}

let inserted = 0;
let skipped = 0;
for (const rec of records) {
  const key = `${rec.taskName}@${rec.ts}`;
  if (seen.has(key)) {
    skipped += 1;
    continue;
  }
  // 有历史就说明用过这个任务，顺带把实例建出来；建不了（比如超上限）不影响导入
  try {
    if (!mine.getSubscription(rec.taskName)) mine.subscribe(rec.taskName);
  } catch (err) {
    console.warn(`[warn] 无法为 ${rec.taskName} 建立订阅：${err.message}`);
  }
  mine.appendRun(rec);
  seen.add(key);
  inserted += 1;
}

console.log(`\n导入完成：新增 ${inserted} 条，跳过 ${skipped} 条（已存在）`);
console.log(`数据库总计：${new Set(records.map((r) => r.taskName)).size} 个任务`);
db.close();
