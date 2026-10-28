/**
 * WorkBuddy 每日活跃 —— 用一次真实对话点亮「活跃地图」
 *
 * 与 workbuddy-checkin 是两套完全独立的统计（实测 2026-10-28）：
 *   · 签到  POST /billing/meter/daily-checkin  → 每天 100 积分，看 checkin_dates
 *   · 活跃  没有领取接口，服务端按「当天是否跑过一轮对话」记账，看活跃地图
 * 所以本任务不能靠一个 POST 完成，必须真的让 agent 跑一轮。
 *
 * 链路（全部实测跑通，2026-10-28，模型回了「收到」）：
 *
 *   1. POST /console/as/conversations/ {prompt, model}
 *        → data.id / data.session.{link, token}
 *        这是「云端会话」：sandbox 由服务端起，客户端不在线也能跑。
 *
 *   2. POST <link>/acp/bootstrap  （body = initialize）
 *        → 响应头 Acp-Connection-Id，body 是一条 SSE 下行流
 *        ★ 坑：connection id 是**服务端下发**的，自己造 UUID 会得到
 *          「connection not found」。第一次必须在 bootstrap 上拿。
 *
 *   3. POST <link>/acp  （带 Acp-Connection-Id）
 *        session/new → session/set_model → session/prompt
 *        回复以 session/update(agent_message_chunk) 流式回来，
 *        session/endTurn 通知表示这一轮结束 —— 这是唯一的成功判据。
 *
 * 该域名只认 SSE，不认 WebSocket（upgrade 会被 CloudStudio Gateway 拒绝，
 * 它要求 Accept 同时包含 application/json 与 text/event-stream）。
 *
 * 模型：hy3 是 availableModels 里唯一 x0.00 credits 的（限时免费）。
 * 其余最近的是 0.05，所以这个值写死不做成配置。
 */
import { timestampInTZ } from '../src/util.mjs';
import { STATUS } from '../src/task-contract.mjs';
// 同站点的姊妹任务，共用「token 剩余天数」这套判断，避免两份实现漂移
import { daysLeft, tokenExpiryMs, WARN_DAYS } from './workbuddy-checkin.mjs';

const BASE = 'https://www.workbuddy.cn';

/** 唯一 0.00x 倍率的模型（2026-10-28 实测 availableModels） */
export const FREE_MODEL = 'hy3';

/**
 * 发出去的那句话。
 *
 * 服务端拿 prompt 前 100 字当会话标题，所以这句会原样出现在会话列表里——
 * 写「你好」比写「每日活跃自动任务」更像真人，也不会污染用户的标题栏。
 */
export const PROMPT = '早上好';

/** ACP 侧总预算：起 sandbox 约 20~40s，一轮短对话约 5~15s，留足 */
const ACP_BUDGET_MS = 180_000;

/** 建会话后 sandbox 还在 CREATING，bootstrap 前几次必然连不上 */
const BOOTSTRAP_ATTEMPTS = 8;
const BOOTSTRAP_GAP_MS = 3_000;

/* ───────────────────── SSE ───────────────────── */

/**
 * 增量 SSE 解析：喂进一段文本，吐出完整的 `data:` 事件。
 *
 * 单独抽出来是因为它是这条链路里最容易写错的一环（分块边界可能落在
 * 一个事件中间），而且不依赖网络就能测。
 *
 * @param {string} buffer 累积的未消费文本
 * @returns {{ events: any[], rest: string }}
 */
export function parseSse(buffer) {
  const events = [];
  let rest = buffer;
  for (;;) {
    const i = rest.indexOf('\n\n');
    if (i < 0) break;
    const block = rest.slice(0, i);
    rest = rest.slice(i + 2);
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    // 心跳（单独一个 `:`）与注释块没有 data 行，直接跳过
    if (!data) continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      /* 半截 JSON：宁可丢一条通知，也不要整轮失败 */
    }
  }
  return { events, rest };
}

/**
 * 从一条 session/update 通知里取出「文本 + 属于哪一类」。
 *
 * 必须区分类型：思考模型（hy3 就是）会同时推 `agent_thought_chunk` 和
 * `agent_message_chunk`，混着拼会得到「用户说早上好，这是一句问候……」
 * 这种把内心独白当回答的结果。
 */
export function chunkText(msg) {
  const u = msg?.params?.update ?? {};
  const text = u.content?.text ?? u.delta?.text ?? '';
  return { kind: String(u.sessionUpdate ?? ''), text: text ? String(text) : '' };
}

/* ───────────────────── ACP 客户端 ───────────────────── */

/**
 * 极简 ACP 客户端：只实现这条任务需要的四个方法。
 *
 * 刻意不复用 src/http.mjs 的 request —— 那边是给「目标站点」用的浏览器伪装，
 * 而这里是 sandbox 内网代理，需要的恰恰是精确的 Accept 头与可中断的长连接。
 */
class AcpConnection {
  #acpUrl;
  #bootUrl;
  #token;
  #connId = null;
  #seq = 0;
  #pending = new Map();
  #onChunk;
  #onEndTurn = null;
  #abort = new AbortController();
  #closed = false;

  constructor({ link, token, onChunk }) {
    this.#acpUrl = link.replace(/\/acp\/?$/, '/acp');
    this.#bootUrl = link.replace(/\/acp\/?$/, '/acp/bootstrap');
    this.#token = token;
    this.#onChunk = onChunk;
  }

  #headers(extra = {}) {
    return {
      Authorization: `Bearer ${this.#token}`,
      ...(this.#connId ? { 'Acp-Connection-Id': this.#connId } : {}),
      ...extra,
    };
  }

  /** 握手：拿 connection id 并开始消费下行流。返回是否成功。 */
  async connect(attempts = BOOTSTRAP_ATTEMPTS) {
    let lastError = null;
    for (let i = 1; i <= attempts; i++) {
      try {
        const res = await fetch(this.#bootUrl, {
          method: 'POST',
          headers: this.#headers({
            Accept: 'text/event-stream',
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: 1,
              clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            },
          }),
          signal: this.#abort.signal,
        });
        const connId = res.headers.get('acp-connection-id');
        if (!res.ok || !connId) throw new Error(`bootstrap HTTP ${res.status}（无 Acp-Connection-Id）`);
        this.#connId = connId;
        this.#pump(res.body);
        return { ok: true, attempts: i };
      } catch (err) {
        lastError = err;
        if (i < attempts) await new Promise((r) => setTimeout(r, BOOTSTRAP_GAP_MS));
      }
    }
    return { ok: false, error: lastError };
  }

  /** 后台消费 SSE 流，把响应分发给等待中的调用，把助手文本交给 onText */
  async #pump(body) {
    if (!body) return;
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = parseSse(buffer);
        buffer = rest;
        for (const msg of events) this.#dispatch(msg);
      }
    } catch {
      /* abort 或连接被关：由调用方按「没等到 endTurn」处理 */
    }
  }

  #dispatch(msg) {
    if (msg.id != null && this.#pending.has(msg.id)) {
      const waiter = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error).slice(0, 200)));
      else waiter.resolve(msg);
      return;
    }
    if (msg.method === 'session/request_permission') {
      // 只用纯问答不开工具，正常不会走到这里；走到了就拒绝，让这一轮自然结束
      this.post({
        jsonrpc: '2.0',
        id: msg.id,
        result: { outcome: { outcome: 'cancelled' } },
      }).catch(() => {});
      return;
    }
    if (msg.method === 'session/update') {
      const chunk = chunkText(msg);
      if (chunk.text) this.#onChunk?.(chunk);
      return;
    }
    if (msg.method === 'session/endTurn') this.#onEndTurn?.(msg);
  }

  /** 上行：单条 JSON-RPC，服务端回 202，真正的响应走下行流 */
  async post(payload) {
    const res = await fetch(this.#acpUrl, {
      method: 'POST',
      headers: this.#headers({
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify(payload),
      signal: this.#abort.signal,
    });
    // 202 = 已受理；非 2xx 才是真错（connection not found 也在这里暴露）
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`ACP HTTP ${res.status} ${text}`);
    }
    return res;
  }

  /**
   * 只发不等：`session/prompt` 的 JSON-RPC 响应要等整轮结束才回，
   * 而结束信号是下行流里的 `session/endTurn`。等响应等于白等一个必然超时。
   */
  send(method, params) {
    const id = ++this.#seq + 1;
    return this.post({ jsonrpc: '2.0', id, method, params });
  }

  call(method, params, timeoutMs = 60_000) {
    const id = ++this.#seq + 1; // 1 已被 bootstrap 占用
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.post({ jsonrpc: '2.0', id, method, params })
        .then(() => {
          // post 成功不代表响应到了，timer 仍然有效
        })
        .catch((err) => {
          clearTimeout(timer);
          if (this.#pending.delete(id)) reject(err);
        });
    });
  }

  /** 等 endTurn：这是「这一轮真的跑完了」的唯一信号 */
  waitEndTurn(timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#onEndTurn = null;
        reject(new Error(`等待 session/endTurn 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.#onEndTurn = (msg) => {
        clearTimeout(timer);
        this.#onEndTurn = null;
        resolve(msg);
      };
    });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#abort.abort();
  }
}

/* ───────────────────── 主站请求 ───────────────────── */

/** 建云端会话。失败会抛，由 run 统一映射状态。 */
async function createConversation(request, token) {
  const res = await request(`${BASE}/console/as/conversations/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept-Language': 'zh-CN',
    },
    body: JSON.stringify({ prompt: PROMPT.slice(0, 100), model: FREE_MODEL }),
    timeout: 30_000,
  });
  if (res.status === 401) return { unauthorized: true };
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON，下面按 blocked 处理 */
  }
  if (!json?.data?.session?.link || !json?.data?.session?.token) {
    return { error: `建会话异常（HTTP ${res.status}）：${text.slice(0, 200)}` };
  }
  return {
    conversationId: json.data.id,
    link: json.data.session.link,
    sessionToken: json.data.session.token,
  };
}

/* ───────────────────── 任务 ───────────────────── */

export default {
  name: 'workbuddy-active',
  displayName: 'WorkBuddy 每日活跃（发起一次对话）',
  description: '每天用免费模型发起一次云端对话，记录当日活跃（不领取积分，积分见签到任务）',
  group: '签到',
  tags: ['签到', '活跃', '对话'],
  requires: ['WB_ACCESS_TOKEN'],

  /** 与签到任务同一把钥匙，抓取方法也一样 */
  credentialHelper: {
    download: 'grab-workbuddy-token.mjs',
    command: 'node grab-workbuddy-token.mjs',
    note: '需要 Node 18+。客户端装在 C 盘以外也能自动找到；运行时会短暂重启 WorkBuddy（约 10 秒），完成后自动恢复原样。',
  },

  accounts: false,

  schedule: { window: { start: '09:00', end: '09:50' } },

  /** 起 sandbox + 一轮对话，实测 40~60s；上限留三倍余量 */
  timeoutMs: 300_000,

  view: [
    { key: 'model', label: '使用模型', type: 'text' },
    { key: 'reply', label: '助手回复', type: 'text' },
    { key: 'durationMs', label: '耗时', type: 'duration' },
    { key: 'conversationId', label: '会话 ID', type: 'text' },
    { key: 'tokenDaysLeft', label: '凭据剩余天数', type: 'number' },
  ],

  async run({ secrets, request, log }) {
    const token = secrets.WB_ACCESS_TOKEN;
    const expMs = tokenExpiryMs(token);
    const left = daysLeft(expMs);

    if (left !== null && left < 0) {
      return {
        status: STATUS.CONFIG,
        message: `凭据已于 ${timestampInTZ(new Date(expMs))} 过期（${-left} 天前），请重新获取 WB_ACCESS_TOKEN`,
        data: { tokenDaysLeft: left },
      };
    }
    if (left !== null && left <= WARN_DAYS) {
      log(`⚠️ 凭据 ${left} 天后过期，到期前活跃任务会失败，请提前更新`);
    }

    const startedAt = Date.now();

    log(`创建云端会话（模型 ${FREE_MODEL}）…`);
    const created = await createConversation(request, token);
    if (created.unauthorized) {
      return {
        status: STATUS.CONFIG,
        message: '凭据已失效（HTTP 401 invalid_token），请重新获取 WB_ACCESS_TOKEN 并填写到任务页',
        data: Number.isFinite(left) ? { tokenDaysLeft: left } : {},
      };
    }
    if (created.error) {
      return { status: STATUS.BLOCKED, message: created.error, data: {} };
    }
    const { conversationId, link, sessionToken } = created;
    log(`会话 ${conversationId} 已创建，等待 sandbox 就绪…`);

    /* agent_message_chunk 是回答，agent_thought_chunk 是内心独白；两个都留着，展示优先用前者 */
    let reply = '';
    let thought = '';
    const acp = new AcpConnection({
      link,
      token: sessionToken,
      onChunk: ({ kind, text }) => {
        if (kind === 'agent_message_chunk') reply += text;
        else thought += text;
      },
    });

    try {
      const connected = await acp.connect();
      if (!connected.ok) {
        return {
          status: STATUS.NETWORK,
          message: `连接 sandbox 失败（重试 ${BOOTSTRAP_ATTEMPTS} 次）：${connected.error?.message ?? '未知原因'}`,
          data: { conversationId },
        };
      }
      log(`已连接 sandbox（第 ${connected.attempts} 次尝试）`);

      // 抓包路径要求：initialize 完成后才能用 RPC；session/new 会返回可切换的模型表
      const created2 = await acp.call('session/new', { cwd: '/workspace', mcpServers: [] }, 60_000);
      const sessionId = created2.result?.sessionId;
      if (!sessionId) {
        return {
          status: STATUS.BLOCKED,
          message: `session/new 未返回 sessionId：${JSON.stringify(created2.result ?? created2).slice(0, 200)}`,
          data: { conversationId },
        };
      }

      /*
       * 会话默认模型是 hy4-preview（0.29x 计费），必须显式切到免费模型再提问。
       * 切换失败不终止：先跑一轮，把实际用的模型如实记在结果里，
       * 让用户看到「花了钱」而不是悄悄扣费。
       */
      let model = 'default';
      try {
        await acp.call('session/set_model', { sessionId, modelId: FREE_MODEL }, 30_000);
        model = FREE_MODEL;
        log(`已切换到免费模型 ${FREE_MODEL}`);
      } catch (err) {
        log(`⚠️ 切换模型失败，将使用会话默认模型：${err.message}`);
      }

      const endTurn = acp.waitEndTurn(ACP_BUDGET_MS);
      await acp.send('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: PROMPT }],
      });

      log('等待助手回复…');
      await endTurn;

      const durationMs = Date.now() - startedAt;
      // 极少数模型只推思考不推正文；这时退回思考，也比显示「(空)」有用
      const trimmed = (reply.trim() || thought.trim()).slice(0, 200);
      const data = {
        model,
        reply: trimmed.slice(0, 200) || '(空)',
        durationMs,
        conversationId,
      };
      if (Number.isFinite(left)) data.tokenDaysLeft = left;

      return {
        status: STATUS.SUCCESS,
        message: `活跃已点亮（${model} 耗时 ${Math.round(durationMs / 1000)}s，回复「${trimmed.slice(0, 40) || '空'}」）`,
        data,
      };
    } catch (err) {
      return {
        status: STATUS.FAILED,
        message: `对话未完成：${err.message}`,
        data: {
          conversationId,
          reply: (reply.trim() || thought.trim()).slice(0, 200) || undefined,
          durationMs: Date.now() - startedAt,
        },
      };
    } finally {
      acp.close();
    }
  },
};
