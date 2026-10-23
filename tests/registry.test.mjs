/**
 * registry.mjs 单元测试 —— 任务定义校验与加载
 *
 * 校验全部前移到加载期，好处是「任务定义写错」在 `weauto list` 就暴露，
 * 而不是等到当天窗口触发、真去执行时才炸（那时排查成本高得多）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertValidTask, getTask, loadTasks } from '../src/registry.mjs';
import { hhmmToSeconds } from '../src/util.mjs';

const base = { name: 'demo', run: async () => ({ status: 'success' }) };

describe('assertValidTask', () => {
  it('接受最小合法定义', () => {
    assert.doesNotThrow(() => assertValidTask({ ...base }, 'demo.mjs'));
  });

  it('接受包含可选字段的完整定义', () => {
    assert.doesNotThrow(() =>
      assertValidTask(
        {
          ...base,
          displayName: '演示任务',
          requires: ['A', 'B'],
          schedule: { window: { start: '09:00', end: '09:50' } },
        },
        'demo.mjs',
      ),
    );
  });

  it('非对象 / 缺 name / 缺 run 一律报错', () => {
    assert.throws(() => assertValidTask(null, 'x.mjs'), /未导出 default 对象/);
    assert.throws(() => assertValidTask({ run: base.run }, 'x.mjs'), /缺少 name/);
    assert.throws(() => assertValidTask({ name: 'x' }, 'x.mjs'), /缺少 run 函数/);
  });

  it('displayName 必须是字符串', () => {
    assert.throws(() => assertValidTask({ ...base, displayName: 42 }, 'x.mjs'), /displayName/);
  });

  it('requires 必须是非空字符串数组', () => {
    for (const bad of ['A', [''], [1], {}]) {
      assert.throws(
        () => assertValidTask({ ...base, requires: bad }, 'x.mjs'),
        /requires/,
        `应拒绝 ${JSON.stringify(bad)}`,
      );
    }
  });

  it('窗口必须是 HH:MM 格式，不接受「差不多」的写法', () => {
    const cases = [
      ['9:00', '09:50'],
      ['09:00', '9:50'],
      ['09:00', ''],
      ['0900', '0950'],
      [null, '09:50'],
      ['24:00', '25:00'],
      ['09:60', '10:00'],
    ];
    for (const [start, end] of cases) {
      assert.throws(
        () => assertValidTask({ ...base, schedule: { window: { start, end } } }, 'x.mjs'),
        /HH:MM/,
        `应拒绝 ${JSON.stringify([start, end])}`,
      );
    }
  });

  it('窗口结束必须晚于开始', () => {
    assert.throws(
      () => assertValidTask({ ...base, schedule: { window: { start: '09:50', end: '09:00' } } }, 'x.mjs'),
      /调度窗口非法/,
    );
  });
});

describe('loadTasks / getTask（对真实 tasks/ 目录）', () => {
  it('能加载到仓库内已注册的任务', async () => {
    const tasks = await loadTasks();
    const t = tasks.get('v2free-checkin');
    assert.ok(t, '应加载到 v2free-checkin');
    assert.equal(t.file, 'v2free-checkin.mjs');
    assert.deepEqual(t.requires, ['V2FREE_EMAIL', 'V2FREE_PASSWORD']);
    /*
     * 只断言「窗口合法且够宽」，不锁死具体时刻。
     * 锁死会让每次调窗口（比如为多账号散开而拉长）都得改测试，
     * 而这条用例真正要守的是「能加载到真实任务并读出调度」。
     */
    const { start, end } = t.schedule.window;
    assert.match(start, /^\d{2}:\d{2}$/);
    assert.match(end, /^\d{2}:\d{2}$/);
    assert.ok(hhmmToSeconds(end) > hhmmToSeconds(start), '窗口结束必须晚于开始');
  });

  it('getTask 对未知任务给出可用列表', async () => {
    await assert.rejects(() => getTask('no-such-task'), /未知任务[\s\S]*v2free-checkin/);
  });
});
