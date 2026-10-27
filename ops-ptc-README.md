# ops-ptc

进程内 AST 重构引擎。用 ast-grep 的 Rust 核心直接改语法树，把「找符号 → 改写 → 审计」全部收在一个 Node 进程里，默认不 fork 任何外部二进制。

- 版本：**2.0.5**（本地验证包，未发布 registry）
- 运行时依赖：`@ast-grep/napi` + `typescript`
- 平台：Windows x64 / Node ≥ 18（实测 Node v24.22.1）
- 许可：MIT

它不是文本替换：`return $A` 是 AST 模式，只会命中真的 `return` 语句，不会改到字符串字面量和注释里。改写结果在落盘前会做一次语法级审计——区间外逐字符零改动 + TypeScript 解析诊断身份比对。

---

## 安装

```bash
npm i ./ops-ptc-2.0.5.tgz
```

包内只有 `dist/` 与四份文档，28 个文件 / 65313 字节（tarball）。不含源码、脚本、基准样本。

## 三个入口

| 入口 | 启动方式 | 适合 |
| --- | --- | --- |
| CLI | `npx ops-ptc <locate\|refactor\|mcp>` | 手动验证、脚本调用 |
| MCP stdio | `node dist/ptc/mcp.js` | 给宿主挂 5 个工具 |
| Node API | `require('ops-ptc')` | 直接嵌进自己的进程 |

三个入口共用同一套引擎，返回同一个 outcome 形状。

---

## CLI

```bash
# 定位：只读，返回符号所在的文件与字节区间
npx ops-ptc locate --symbol getValidRequestBody --roots src --limit 5

# 改写：preview 只合成不落盘，去掉 --mode 就是 apply
npx ops-ptc refactor \
  --pattern 'return $A' \
  --rewrite 'return ($A);' \
  --symbol getValidRequestBody \
  --file src/api.ts \
  --mode preview
```

| 参数 | 说明 |
| --- | --- |
| `--symbol` | 目标符号；`refactor` 给了就把改写锁进该符号体内 |
| `--pattern` / `--rewrite` | AST 模式与重写模板，`$A` 单节点捕获，`$$$ARGS` 变长捕获 |
| `--file` | 已知目标文件，跳过枚举 |
| `--roots` | 搜索根，默认 cwd |
| `--ext` | 限定扩展名，默认 `ts,tsx` |
| `--limit` | 本次最多处理多少个文件，默认 1 |
| `--mode` | `apply`（默认）或 `preview`；非法值直接拒绝，不会退化成 apply |
| `--strategy` | `auto`（默认）/ `walk` / `everything` |
| `--strict` | 落盘前额外用 `sg` CLI 复核命中数，需装 ast-grep，约 +36 ms |

退出码：`0` 成功，`1` 业务熔断（看输出里的 `code`），`2` 参数错误。stdout 只有一行 JSON，中间态（文件列表、AST、补丁）不出进程。

---

## MCP

```bash
node dist/ptc/mcp.js     # NDJSON JSON-RPC，stdout 只有协议帧，日志走 stderr
```

协议侧限制：单帧 1 MiB、在途请求 32、应用层输出积压 8 MiB。业务错误会带 `isError: true`，不是协议错误。

五个工具：

| 工具 | 作用 | 必填 |
| --- | --- | --- |
| `ops_ptc_inproc` | 进程内 AST 改写 + 审计 | `pattern` `rewrite` |
| `ops_ptc_locate` | 进程内符号定位，只读 | `symbol` |
| `ops_ptc_refactor` | 五段流水线（外部工具） | `symbol` `pattern` `rewrite` |
| `ops_ptc_find` | 寻址 + 符号切片，只读 | `query` `symbol` |
| `ops_ptc_audit` | 两个文件的结构 diff，只读 | `file` `beforeFile` |

---

## Node API

```ts
const { inprocRefactor, inprocLocate, auditAst } = require('ops-ptc');

// 改写（同步）
const out = inprocRefactor({
  pattern: 'return $A',
  rewrite: 'return ($A);',
  symbol: 'getValidRequestBody',
  file: 'src/api.ts',
  mode: 'preview',          // 'apply' | 'preview'
  strict: false,            // true = 额外用 sg CLI 对账
  strategy: 'auto',         // 'auto' | 'walk' | 'everything'
  scanBudget: 3000,
  limit: 1,
});

// 定位（同步）
const hit = inprocLocate({ symbol: 'getValidRequestBody', roots: ['src'] });
```

成功返回：

```json
{
  "status": "ok",
  "engine": "inproc-ast",
  "file": "src/api.ts",
  "symbol": "getValidRequestBody",
  "edits": 4,
  "files": 1,
  "bytesIn": 147,
  "bytesOut": 155,
  "staged": true,
  "sample": "return -1;",
  "audit": { "ok": true, "hunks": 4, "parser": "tsc", "nodesAdded": 5, "nodesRemoved": 11, "unchangedRatio": 0.72 },
  "ms": 0.43
}
```

失败返回：`{ status: "error", code, message }`。抛栈和源码都不会回显。

`audit.unchangedRatio` 是**区间外**未被触碰的字节占比，不是整文件相似度；`parser` 为 `tsc` 时诊断来自 TypeScript 的 `parseDiagnostics`，退化为 `tree-sitter` 说明 TS 不可用。

---

## 两个引擎

| 引擎 | 入口 | fork 次数 | 适用 |
| --- | --- | --- | --- |
| **inproc** | `ops_ptc_inproc` / `ops_ptc_locate` / `inprocRefactor()` | walk + 非 strict 为 0；Everything 或 strict 另起进程 | 单文件、千级文件；TS / TSX / JS / JSX / HTML / CSS |
| pipeline | `ops_ptc_refactor` / `runRefactorPipeline()` | 4 | 万级文件、其它语言、需要 difftastic 独立审计 |

inproc 覆盖的语言只有 napi 内置的 5 种。Python / Go / Rust / Java 等命中时返回 `fallback: 'spawn'`，交回 pipeline。单文件超过 2 MiB 也同样回退——单次 parse 的收益抵不上阻塞调用方事件循环。

### 寻址策略

| 策略 | 成本特征 | 什么时候用 |
| --- | --- | --- |
| `walk` | 与文件数线性；天然跳过 `node_modules` | 小树、单文件 |
| `everything` | 固定 IPC 成本（约 135 ms），与规模无关 | 必须全量枚举、或树大到早停也走不动 |
| `auto`（默认） | 两边取优 | 判据很便宜：根目录有 `node_modules`，或「深度 ≤3 且子目录 ≥10」⇒ 上 es；否则进程内，并留 250 ms 预算兜底 |

`es.exe` 是可选加速项，不装也能跑。排除语法 `!path:node_modules` 只在 Everything 1.5+ 生效，所以 es 返回的路径一律在 JS 侧再过一道正则，不赌版本。

---

## 安全与写入保证

1. **无 shell**：`spawn(bin, argv, { shell: false })`，参数数组直进 `CreateProcess`，引号、大括号、`%`、`^` 全部失效。
2. **载荷只走 stdin**：代码片段 base64 后塞进 `stdin.write()`，不经任何字符串拼接层。
3. **偏移域严格分离**：napi 的 `startByte/endByte` 实际是 **UTF-16** 索引，CLI 的 `byteOffset` 是 **UTF-8** 字节；跨域处显式转换，中文/emoji/CRLF 有独立回归。
4. **先审计后落盘**：多文件先把全部候选审计完，任一失败则一个字节都不写。
5. **写入屏障**：协作锁 + 独占随机临时文件 + 写前写后双快照 + `rename`；保留原文件 mode。
6. **清理回执**：文件已提交后若清理临时件/锁失败，错误会附在 `cleanupErrors` 里，不会把「已落盘」误报成失败。

不提供的保证：并发不是文件系统 CAS；多文件写入不是事务（中途失败用 `committed` / `partial` 如实报告）；进程被硬杀可能留 stale lock；不覆盖 `symlink`/`junction` 竞态。

---

## 性能（2.0.5 vs 2.0.0，同机串行交替 AB/BA）

热路径，14 个可逐字节对比的场景，13 个 ≥ 1.0：

| 场景 | 2.0.0 | 2.0.5 | 倍率 |
| --- | ---: | ---: | ---: |
| large-1500 / inproc / preview | 89.00 ms | 13.65 ms | **6.52x** |
| many-750 / inproc / preview | 154.53 ms | 35.87 ms | **4.31x** |
| locate-only | 23.84 ms | 8.52 ms | **2.80x** |
| tiny-4-edits / inproc / preview | 0.88 ms | 0.43 ms | **2.04x** |
| large-1500 / pipeline / preview | 521.58 ms | 424.14 ms | 1.23x |
| tiny-4-edits / inproc / apply | 1.82 ms | 1.93 ms | 0.94x |

倍率只在同一次运行内有效，绝对值不可跨运行比较。`tiny-4-edits / inproc / apply` 低于 1.0 的原因写在报告里：差值全部落在 2.0.1 新增的原子写屏障上，2.0.0 是直接覆盖。

完整表格、冷路径与归因见 `PERFORMANCE_CUMULATIVE.md`。

---

## 验证

```bash
npm ci
npm run verify          # typecheck + build + 3 个 smoke + 12 段回归（154 行 PASS）
npm run test:perf       # 347 项审计差分 + 36 组定位/改写差分
npm pack && npm run smoke:package   # 生产安装 + 消费端 5 项
```

| 回归 | 项数 |
| --- | ---: |
| safety / ast / worker | 15 / 19 / 16 |
| protocol / pipeline | 38 / 22 |
| mode-audit / audit-root-cache / cleanup | 28 / 11 / 3 |
| pipeline-perf / deep-inproc / locate-parity | 7 / 36 / 84 |
| dist-shape | 1 |

pipeline 与 strict 对账需要本机已装 `ast-grep` 与 `difftastic`；Everything 查询需要 es.exe 与运行中的服务。纯 walk inproc 不需要任何外部二进制。

---

## 边界

1. **解析 ≠ 语义**：`parseDiagnostics` 不做类型检查，tree-sitter 容错解析可能吞掉错误（所以带 TS 诊断做第二道）。
2. **枚举 ≠ 完整搜索**：上限、30 秒缓存、启发式预筛与预算会导致剪枝。`truncated` / `pruned` 为真时结果可能不完整，找不到不能推断不存在。
3. **BOM 源码 fail-closed**：带 BOM 的源码目前直接报 `E_AST_AUDIT_SPLICE`，不静默处理。
4. **未测平台**：Node 18 / Linux / macOS 没有验收。
5. **可信宿主桥未接线**：adapter 已通过真实 dsh-ops 契约测试，但路径策略、凭证隔离、取消、提交前授权重验仍由宿主实现，不能把契约测试当作生产权限链验收。

---

## 目录

```
dist/ptc/index.js          公开 API 汇总
dist/ptc/inproc.js         进程内引擎（枚举 / 定位 / 改写 / CLI）
dist/ptc/astdiff.js        AST 审计（拼接校验 + 诊断比对 + 结构统计）
dist/ptc/safe-write.js     写入屏障（锁 / 独占临时 / 快照 / rename）
dist/ptc/pipeline.js       五段编排
dist/ptc/stages.js         五段实现（everything / sane / astgrep / difftastic / agentbox）
dist/ptc/proc.js           spawn 唯一出口 + CRLF/BOM/EOL 收口
dist/ptc/agentbox.worker.cjs  独立落盘进程
dist/ptc/mcp.js            MCP stdio 适配
dist/ptc/tools.js          DSH Tool adapter 元数据
dist/ptc/adapter.js        宿主注册适配
```

文档：`README.md`（本文）、`AUDIT_REPORT.md`（正确性审计 F01–F14）、`PERFORMANCE_CUMULATIVE.md`（2.0.0→2.0.5 累计优化）、`HOST_INTEGRATION.md`（宿主接线）。

---

当前状态：未 commit、未 push、未 publish、未替换生产插件。
