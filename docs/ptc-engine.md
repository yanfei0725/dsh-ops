# 内置 PTC AST 引擎

`ops_ptc_*` 五个工具的引擎直接编译进宿主 `src/ptc/engine/`，不再有旁挂子包。一次 locate / 一次 AST 改写都是对已持有字节的 Tree-sitter parse，起子进程比改动本身还贵（本机实测：CLI 一次 `locate` 94 ms，进程内 14 ms），所以这条路径由宿主自己做，原生文件 worker 不为它启动。

## 位置

| 路径 | 内容 |
| --- | --- |
| `src/ptc/engine/index.ts` | 引擎对外面：`opsPtcAddition`（`tools` + `handlers`）、各能力 re-export |
| `src/ptc/engine/tools.ts` | 五个工具的 `inputSchema` 与 handler |
| `src/ptc/engine/inproc.ts` | 进程内 AST 定位 / 改写 / CLI 入口（884 行） |
| `src/ptc/engine/enumerate.ts` | 分级寻址：walk + Everything（`es.exe`）+ 30 s 结果缓存 |
| `src/ptc/engine/stages.ts` | 五段流水线各阶段（Everything / SANE / ast-grep / AgentBox / difftastic） |
| `src/ptc/engine/astdiff.ts` | 语法级审计、`typescript` parseDiagnostics oracle、根缓存 |
| `src/ptc/engine/pipeline.ts` | 五段流水线编排 |
| `src/ptc/engine/proc.ts` | 子进程封装、`es.exe` 候选链、EOL / JSON 工具 |
| `src/ptc/engine/safe-write.ts` | 快照校验 + 锁 + 原子替换 |
| `src/ptc/engine/reparse.ts` | 枚举路径的链接 / junction 拒绝 |
| `src/ptc/engine/engine-load.ts` | `@ast-grep/napi` 惰性双锚点解析 |
| `src/ptc/engine/anchors.ts` | `PACKAGE_ROOT`（`src/ptc/engine` 上三级） |
| `src/ptc/engine/schema.json` | 五个工具的 schema，`src/capabilities/ptc.ts` 直接读入展开 |
| `src/ptc/engine/adapter.ts` | 外部宿主的桥接样板（`createHostTools`），宿主自己不走这条 |
| `src/ptc/engine/cli.ts` / `mcp.ts` | 独立 CLI / MCP 端点，宿主不 import |
| `bin/ptc-agentbox.worker.cjs` | AgentBox 落盘子进程（手写 CJS；`src/` 编译入口只收 TypeScript） |
| `src/file/ptc-inproc.ts` | 适配层：四步围栏 + 回执闸门，`ops_ptc_*` 的唯一入口 |

`src/ptc/` 其余文件（`index.ts`、`worker.ts`、`runtime.ts`、`invoke.ts`、`contract.ts`、`config.ts`、`sdk.ts`、`projection/`）仍是 PTC 的 `run_code` 表面，与引擎无关，互不覆盖。

## 五个工具

| 工具 | 必填 | 写 | 发布档 | 说明 |
| --- | --- | --- | --- | --- |
| `ops_ptc_locate` | `symbol` | 否 | resident | 枚举 → 子串预筛 → 单文件 parse，只回行区间、签名、字节量；`body` 控制是否附正文 |
| `ops_ptc_find` | `query` | 否 | discoverable | `query` 寻址后可选 `symbol` 定位；省略 `symbol` 只回文件列表 |
| `ops_ptc_refactor` | `query`、`symbol`、`pattern`、`rewrite` | **是**（`mode=preview` 除外） | discoverable | 五段流水线，需要 `workspace-write` |
| `ops_ptc_inproc` | `pattern`、`rewrite` | **是**（`mode=preview` 除外） | resident | 进程内改写；`strict=true` 额外用 sg CLI 对账 |
| `ops_ptc_audit` | `file`、`beforeFile` | 否（只建/删临时目录） | discoverable | 两版本语法级 diff，`read-only` 下仍可用 |

schema 只有一处来源：`src/ptc/engine/schema.json`。`src/capabilities/ptc.ts` 用 JSON import 展开，`required` 同时驱动适配层的缺参早退，手抄一份必然漂移。

## 四步围栏（顺序固定）

`src/file/ptc-inproc.ts` 的 `invokePtc()`，与原生文件 worker 同序、同理，因为这里没有 spawn 可以承载围栏：

1. **session / cwd**：`exec.agent.session.id` 与绝对 `header.cwd`，缺一即 `EXECUTOR_UNAVAILABLE`。
2. **一次权威策略解析**：`sandboxPolicy.resolve({ session })`，`mode` 必须落在 `read-only | workspace-write | danger-full-access`，`workspaceRoot` 必须绝对。写意图（`ops_ptc_inproc` / `ops_ptc_refactor` 且 `mode !== 'preview'`）在 `read-only` 下直接 `POLICY_DENIED`。
3. **凭据围栏先于锚定**：对每个 `file`、`beforeFile`、`roots[]` 先按调用方给的名字（相对 cwd 解析）过 `credentialPath()`，命中即 `CREDENTIAL_DENIED`，不泄露真实父路径。
4. **workspace 锚定 + 重解析点**：非 `danger-full-access` 时，每个目标必须落在 `workspaceRoot` 或 session cwd 内；随后一次 `realpath` 同时给出「是否有链接」与「字节真身」，链接一律 `PATH_RESTRICTED`，真身再复核锚点与凭据。不存在路径不判罪，交给引擎报 `NOT_FOUND` / `E_NO_FILE`。

回执一律带 `sandbox.boundary = 'in-process-ptc-ast'`，`sandbox.mode` 报真实解析结果（围栏拒绝也报真实档位）。

## 回执闸门

`invokePtc()` 出口按条目降级，绝不让上游截半截 JSON。阈值 24 KiB：

1. 先退命中正文（唯一「可以再买一次」的字段），累加 `bodyOmitted`，并给一条一次够用的 `readHint`（`ops_read_files` + `offset`/`limit`）。
2. 仍超限则按稠密前缀削 `hits` / `files` / `edits`（每次对半），写 `*Omitted` 与 `nextOffset`。
3. 最后一档只留计数：`receiptTruncated = true`，整表删除并记 `hitsOmitted`。

路径口径统一为「相对 cwd 的 POSIX」：引擎有的给绝对路径、有的只给 basename，basename 直接回给模型会让一次成功的定位变成一次失败 + 一次重试。

状态口径也统一：引擎的 `status: 'ok' | 'error'` 在这里翻成宿主的 `completed` / 带结构化 `error` 的失败，写类工具失败且未证明回滚时 `effectState = 'unknown'`。

## 外部二进制缺失时

引擎默认零外部二进制，缺件按能力降级，绝不猜：

| 缺什么 | 后果 |
| --- | --- |
| `@ast-grep/napi` | 首调用加载失败、五个工具都不可用。解析锚点：`<repo>/node_modules` → `<repo>/vendor/deps`（`vendor/deps/node_modules` 是随包分发副本）。它声明在 `optionalDependencies`，装不上不阻塞安装 |
| `es.exe`（Everything） | `strategy=auto` 退回 walk；`strategy=everything` 与 `ops_ptc_refactor` 报 `E_BIN_MISSING`。候选链：显式配置 → `<cwd>/vendor/es.exe` → `<cwd>/es.exe` → `<repo>/vendor/es.exe` → Everything 安装目录 → `PATH` |
| `ast-grep` CLI | 只影响 `strict=true` 的复核与五段流水线，报 `E_BIN_MISSING`；进程内路径不受影响 |
| `difftastic` | `ops_ptc_audit` 与流水线审计阶段报 `E_BIN_MISSING`；`PTC_REQUIRE_DIFFT=1` 时整条流水线回滚 |
| `typescript` | 只是语法 oracle 退化：改用 Tree-sitter 的 ERROR 节点判定 |

凡「找不到可执行文件」，回执保留候选链全文，模型据此判断是装工具还是换策略。

## 验证

```bash
node --experimental-strip-types --check src/ptc/engine/*.ts
node --experimental-strip-types --check src/file/ptc-inproc.ts
npm run typecheck   # 需要 node_modules（含可选依赖 @ast-grep/napi）
```
