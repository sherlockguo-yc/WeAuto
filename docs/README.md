# WeAuto 文档索引

## 功能规格/（先看这个）

- [WeAuto 功能规格](功能规格/weauto.md)
  **现在**怎么工作 —— 修改本模块之前的必读项，需随实现变化同步更新。

## 需求文档/（为什么这么设计）

按版本**倒序**读——最新的那版才是当前形态的由来：

| 版本 | 文档 | 状态 |
|---|---|---|
| v3 | [多租户化](requirements/weauto-multi-tenant.md) | 已实现（2026-10-15）。当前形态的由来：多用户、邀请码注册、每用户凭据、数据隔离 |
| v2 | [独立化重构](requirements/weauto-standalone.md) | 已实现（2026-10-15），已被 v3 取代。把「被动 CLI」改成自带调度与 Web 界面的常驻服务 |
| v1 | [WeAuto 需求文档](requirements/weauto.md) | **已冻结**（2026-10-13）。被动 CLI + 调度交给 WeMonitor 的旧架构，仅作历史决策记录 |
| — | [长期设计契约](requirements/weauto-contract.md) | 跨任务的长期契约（新增任务只改任务文件本身）。校验落地在 `src/task-contract.mjs`，现状见功能规格 §6 |

## 阅读顺序

动手改代码之前：先读 [功能规格](功能规格/weauto.md) 确认现状，
再回到上表里你关心的那一版需求文档确认设计意图。
需求文档里记录了多处「刻意这么选」的取舍（例如显式指定时区而不依赖系统时区、
撞限流不重试），这些不是可以顺手改掉的东西。

> 仓库根目录的 [README](../README.md) 是一页速览：怎么起服务、怎么加模板、怎么部署。

## 相关仓库

- [WeMonitor](../../WeMonitor) —— 现在只负责 TCP 探活；调度与结果展示都已由 WeAuto 自己承担。
  跨仓库契约（`list --json` 结构、`runs.jsonl` 字段、status 取值）由两侧的
  `tests/contract.test.mjs` / `tests/auto-contract.test.mjs` 共同守住。
