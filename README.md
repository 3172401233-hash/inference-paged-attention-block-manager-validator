# inference-paged-attention-block-manager-validator

验证分页注意力（paged attention）块表、共享页和回收竞争。

本工具是一个**纯 CPU 侧的元数据模拟器**：只模拟逻辑块表、物理块、引用计数、
COW（写时复制）与请求状态机，**不访问 GPU**，不需要 CUDA 或任何显卡环境，
仅用 Node.js（≥ 20，开发验证使用 24.16.0）即可运行。

## 模型与不变量

- 多个请求可通过 `share` 共享物理块（如前缀共享），引用计数随之增加；
- **活动请求依赖的块不能回收**：安全回收范围 = 已分配、引用计数为 0、
  且无进行中读取的物理块；
- **共享块写入前必须完成 COW**：引用计数 > 1 的块被写入时，若事件未声明
  `cow: true`，记为不一致；COW 把新块装入错误请求的块表（`into`）或从错误
  源块复制（`copyFrom`）也会被记录；
- **取消竞争**：请求取消后引用计数被释放，但另一请求仍可能在读取同一块，
  进行中读取（`begin_read`/`end_read`）未清零前回收会被拒绝并记录证据。

## 输入

场景为 JSON 文件（见 `examples/scenario.json`）：

```json
{
  "numBlocks": 6,
  "events": [
    { "type": "add_request", "request": "r1", "blocks": [0, 1] },
    { "type": "share", "request": "r2", "from": "r1", "count": 2 },
    { "type": "begin_read", "request": "r2", "index": 0 },
    { "type": "cancel", "request": "r1" },
    { "type": "write", "request": "r2", "index": 0, "cow": true, "content": "x" },
    { "type": "reclaim", "block": 0 }
  ]
}
```

事件类型：`add_request`、`share`（共享前缀）、`append`、`begin_read` /
`end_read`、`write`（含 `cow` / `into` / `copyFrom` / `content`）、
`cancel`、`finish`、`reclaim`。

## 运行

```bash
node bin/validate.js                 # 使用内置示例场景
node bin/validate.js my-scenario.json
node bin/validate.js --json          # 输出完整 JSON 报告
```

每一步输出：各请求逻辑块表、每步可读块、安全回收范围、该步不一致证据；
末尾输出最终物理块状态、回收计划（已执行的安全回收）和不一致证据汇总。
发现不一致时进程退出码为 1。

## 测试

```bash
node --test
```

覆盖：共享前缀、取消竞争、COW（含错误块表/错误源块）、重复回收、
重复释放与引用计数交叉校验。

## 代码结构

- `src/block-manager.js` — 块管理器：块表、引用计数、COW、回收与一致性校验
- `src/simulate.js` — 事件驱动模拟器，产出每步快照与证据
- `bin/validate.js` — CLI 入口
- `test/block-manager.test.js` — `node:test` 测试
