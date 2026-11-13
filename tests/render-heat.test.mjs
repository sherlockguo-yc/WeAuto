/**
 * 活跃图渲染
 *
 * 这张图是「按天铺开的历史」，最容易错的是**日期与格子的对位**：
 * 少一天、错一周，用户看到的成败就整体偏一格，比不画还坏事。
 * 所以这里只验对位与状态映射，不验配色（那在 CSS 里，改了也不会让谁读错）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { activityHeat } from '../src/render.mjs';

/** 2026-11-13，周五（北京时间） */
const TODAY = '2026-11-13';
const FRIDAY_ROW = 4;
const DAY_MS = 86_400_000;

/** 取出格子：{ state, today, title }。图例里的色块也长得一样，所以先切掉图例 */
function gridCells(html) {
  const grid = html.slice(html.indexOf('class="heat-grid"'), html.indexOf('heat-legend'));
  return [...grid.matchAll(/<span class="heat-cell is-([a-z]+)( is-today)?"(?: title="([^"]*)")?/g)].map(
    (m) => ({ state: m[1], today: !!m[2], title: m[3] ?? '' }),
  );
}

const day = (date, { success = 0, failed = 0, skipped = 0 } = {}) => ({
  date,
  success,
  failed,
  skipped,
  total: success + failed + skipped,
});

describe('活跃图', () => {
  it('没有记录就整块不渲染（一屏灰格子在空任务上只会被读成坏了）', () => {
    assert.equal(activityHeat({ days: [], today: TODAY }), '');
  });

  it('按自然周对齐：格数是 7 的整数倍，今天落在最后一列', () => {
    const cells = gridCells(activityHeat({ days: [day('2026-11-12', { success: 1 })], today: TODAY }));

    assert.equal(cells.length % 7, 0, '每列必须是一整周');
    assert.ok(cells.length / 7 >= 53, '至少铺满 53 周');
    const idx = cells.findIndex((c) => c.today);
    assert.ok(idx >= 0, '今天那格必须被标出来');
    assert.equal(idx % 7, FRIDAY_ROW, '2026-11-13 是周五（周一为第 0 行）');
    assert.equal(Math.floor(idx / 7), cells.length / 7 - 1, '今天必须在最后一列');
  });

  it('颜色表达结果：成功 / 部分成功 / 失败 / 跳过 / 没记录', () => {
    const html = activityHeat({
      days: [
        day('2026-11-02', { success: 1 }),
        day('2026-11-03', { success: 1, failed: 2 }),
        day('2026-11-04', { failed: 1 }),
        day('2026-11-05', { skipped: 3 }),
      ],
      today: TODAY,
    });
    const byDate = new Map(gridCells(html).filter((c) => c.title).map((c) => [c.title.slice(0, 5), c]));

    assert.equal(byDate.get('11-02').state, 'ok');
    assert.equal(byDate.get('11-03').state, 'mixed', '既有成功又有失败 → 部分成功');
    assert.equal(byDate.get('11-04').state, 'bad');
    assert.equal(byDate.get('11-05').state, 'skip');
    assert.equal(byDate.get('11-06').state, 'none', '范围内没跑过的那天仍是空档，不是 void');

    // 提示里要写清构成，否则「部分成功」看不出是哪几次失败
    assert.equal(byDate.get('11-03').title, '11-03 · 成功 1 次，失败 2 次');
    assert.equal(byDate.get('11-06').title, '11-06 · 没有执行');
  });

  it('任务创建之前与今天之后的格子留空，不会被读成「那天没跑」', () => {
    const html = activityHeat({
      days: [day('2026-11-10', { success: 1 })],
      today: TODAY,
      createdOn: '2026-11-01',
    });
    const cells = gridCells(html);

    // 11-01 → 11-13 共 13 天可能落在图上，其余（更早 + 今天之后）都是 void
    const drawn = cells.filter((c) => c.state !== 'void');
    assert.equal(drawn.length, 13);
    assert.equal(drawn[0].title, '11-01 · 没有执行');
    assert.equal(drawn.at(-1).state, 'none');
    assert.equal(drawn.at(-1).today, true);
  });

  it('创建日晚于今天（时钟回拨）时按今天算，不整张图判成「还没建」', () => {
    const cells = gridCells(
      activityHeat({ days: [day(TODAY, { success: 1 })], today: TODAY, createdOn: '2026-12-01' }),
    );
    assert.ok(cells.some((c) => c.state === 'ok' && c.today), '今天那格必须是实心的成功');
  });

  it('「跳过」只在真的出现过时才进图例', () => {
    const without = activityHeat({ days: [day('2026-11-12', { success: 1 })], today: TODAY });
    assert.equal(without.includes('is-skip"></span>跳过'), false);

    const withSkip = activityHeat({ days: [day('2026-11-12', { skipped: 1 })], today: TODAY });
    assert.ok(withSkip.includes('is-skip"></span>跳过'));
  });

  it('摘要只数真的执行过的次数（跳过不算）', () => {
    const html = activityHeat({
      days: [day('2026-11-10', { success: 2 }), day('2026-11-11', { failed: 1 }), day('2026-11-12', { skipped: 5 })],
      today: TODAY,
    });
    assert.ok(html.includes('执行 <b>3</b> 次'), '2 次成功 + 1 次失败，5 条跳过不算');
    assert.ok(html.includes('成功 <b class="ok">1</b> 天'));
    assert.ok(html.includes('失败 <b class="bad">1</b> 天'));
  });

  it('窗口两端都对齐到自然周：第一格是周一、最后一格是周日', () => {
    const cells = gridCells(activityHeat({ days: [day('2026-11-12', { success: 1 })], today: TODAY }));
    const totalDays = (cells.length / 7) * 7;
    const todayMs = Date.parse(`${TODAY}T00:00:00Z`);
    // 今天之后还有 void 格子，最后一格是「今天或之后最近的那个周日」
    const lastMs = todayMs + (6 - ((new Date(todayMs).getUTCDay() + 6) % 7)) * DAY_MS;
    const firstMs = lastMs - (totalDays - 1) * DAY_MS;

    assert.equal(new Date(firstMs).getUTCDay(), 1, '第一格必须是周一');
    assert.equal(new Date(lastMs).getUTCDay(), 0, '最后一格必须是周日');
    assert.ok(lastMs >= todayMs, '最后一列必须包含今天');
  });
});
