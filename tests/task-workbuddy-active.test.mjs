/**
 * WorkBuddy 活跃任务的纯函数测试
 *
 * 这条链路只有两处逻辑能被单测覆盖，也恰好是两处「写错了会静默出错」的地方：
 *   · parseSse：SSE 块边界可能落在一个事件中间。少了半截就会把响应当成
 *     「没收到」，任务于是必然超时——但错误现象看起来像网络问题。
 *   · chunkText：思考模型的内心独白和正文走同一个通道的不同子类型，
 *     不区分就会把「用户说早上好，这是一句问候」当成回答展示给用户。
 *
 * 协议事实来自 2026-10-28 的真实实测，见任务文件头部注释。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FREE_MODEL, PROMPT, chunkText, parseSse } from '../tasks/workbuddy-active.mjs';
import { loadTasks } from '../src/registry.mjs';

const sse = (...payloads) => payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).join('');

describe('parseSse', () => {
  it('解析单个完整事件', () => {
    const { events, rest } = parseSse(sse({ jsonrpc: '2.0', method: 'session/endTurn' }));
    assert.equal(events.length, 1);
    assert.equal(events[0].method, 'session/endTurn');
    assert.equal(rest, '');
  });

  it('一次喂多个事件按顺序全部吐出', () => {
    const { events } = parseSse(sse({ id: 1 }, { id: 2 }, { id: 3 }));
    assert.deepEqual(events.map((e) => e.id), [1, 2, 3]);
  });

  it('心跳行（单独一个冒号）被忽略，不产生事件', () => {
    const { events, rest } = parseSse(':\n\n:\n\n');
    assert.deepEqual(events, []);
    assert.equal(rest, '');
  });

  it('事件被切断时把残留留在 rest，补齐后再解析', () => {
    const full = sse({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk' } } });
    const head = full.slice(0, 20);
    const first = parseSse(head);
    assert.equal(first.events.length, 0, '半截事件不能提前吐出');
    assert.equal(first.rest, head);

    const second = parseSse(first.rest + full.slice(20));
    assert.equal(second.events.length, 1);
    assert.equal(second.events[0].params.update.sessionUpdate, 'agent_message_chunk');
  });

  it('半截 JSON 只丢那一条，不影响后续事件', () => {
    const { events } = parseSse('data: {"broken\n\ndata: {"id":9}\n\n');
    assert.equal(events.length, 1);
    assert.equal(events[0].id, 9);
  });
});

describe('chunkText', () => {
  it('正文与思考分别标注类型', () => {
    const msg = (kind, text) => ({ params: { update: { sessionUpdate: kind, content: { text } } } });
    assert.deepEqual(chunkText(msg('agent_message_chunk', '早上好')), {
      kind: 'agent_message_chunk',
      text: '早上好',
    });
    assert.deepEqual(chunkText(msg('agent_thought_chunk', '用户说早上好')), {
      kind: 'agent_thought_chunk',
      text: '用户说早上好',
    });
  });

  it('只带 delta 的更新也能取到文本', () => {
    assert.equal(chunkText({ params: { update: { sessionUpdate: 'agent_message_chunk', delta: { text: 'x' } } } }).text, 'x');
  });

  it('没有任何文本时返回空串而不是 undefined', () => {
    assert.deepEqual(chunkText({ params: { update: { sessionUpdate: 'usage_update' } } }), {
      kind: 'usage_update',
      text: '',
    });
    assert.deepEqual(chunkText({}), { kind: '', text: '' });
  });
});

describe('任务定义', () => {
  it('能被注册表加载，且调度窗口合法', async () => {
    const tasks = await loadTasks();
    const task = tasks.get('workbuddy-active');
    assert.ok(task, 'tasks/workbuddy-active.mjs 应被自动发现');
    assert.deepEqual(task.schedule, { kind: 'window', window: { start: '09:00', end: '09:50' } });
    assert.deepEqual(task.requires, ['WB_ACCESS_TOKEN']);
    assert.equal(task.accounts, false);
  });

  it('用免费模型：倍率写死 0.00 的那一个', () => {
    assert.equal(FREE_MODEL, 'hy3');
  });

  it('prompt 不超过服务端用于标题的 100 字', () => {
    assert.ok(PROMPT.length <= 100);
  });
});
