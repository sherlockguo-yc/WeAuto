# WeAuto 文档索引

## 需求文档/

- [WeAuto 需求文档](requirements/weauto.md)
  **为什么**这么设计 —— 方案对比、废弃方案、实测修正记录。

## 功能规格/

- [WeAuto 功能规格](功能规格/weauto.md)
  **现在**怎么工作 —— 修改本模块之前的必读项，需随实现变化同步更新。

## 阅读顺序

动手改代码之前：先读 [功能规格](功能规格/weauto.md) 确认现状，
再读 [需求文档](requirements/weauto.md) 确认设计意图。
需求文档里记录了多处「刻意这么选」的取舍（例如显式指定时区而不依赖系统时区、
撞限流不重试），这些不是可以顺手改掉的东西。

## 相关仓库

- [WeMonitor](../../WeMonitor) —— 调度（`/cron`）与结果展示（`/auto`）。
  两个仓库之间存在跨仓库契约（`list --json` 结构、`runs.jsonl` 字段、status 取值），
  由两侧的 `tests/contract.test.mjs` / `tests/auto-contract.test.mjs` 共同守住。
