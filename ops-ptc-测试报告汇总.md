# ops-ptc 测试与审计报告汇总

整合对象：`K:/ai/ops-ptc`，版本 **2.0.5**  
环境：Windows x64 / Node v24.22.1 / AMD Ryzen 7 9700X（8C16T）  
汇总日期：2026-10-28  
状态：未 commit / 未 push / 未 publish / 未替换生产插件

本文把 2.0.1 起散落在四份报告与 `audit/perf-round*` 原始样本里的结论并成一份可独立阅读的验收记录。所有数字都来自已落盘的日志与 JSON，不是复述。

---

## 0. 一页结论

| # | 结论                                                                                                                      | 证据                   |
| - | ----------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 1 | 正确性审计 14 项（F01–F14）全部有复现案例与回归覆盖                                                                                         | §2，`AUDIT_REPORT.md` |
| 2 | 曾被打 ⚠ 的两个性能倒退点已收敛：`tiny/inproc/preview` 0.911x → **2.041x**；`large-1500/pipeline/preview` 0.856x → **1.230x**（均对 2.0.0） | §4                   |
| 3 | 14 个可与 2.0.0 逐字节对比的热路径场景，**13 个 ≥ 1.0**，最大 **6.518x**                                                                   | §3                   |
| 4 | 唯一 < 1.0 的 `tiny/inproc/apply` 0.944x，差值全部落在 2.0.1 新增的原子写屏障，删屏障才能追平                                                     | §5.1                 |
| 5 | 2.0.5 精简：tarball 134165 → **65313** 字节（−51.3%），15 个场景输出逐字节不变                                                            | §6                   |
| 6 | 全量验收 `verify` rc=0，154 行 PASS；回归 280 项；`test:perf` 383 项差分                                                              | §7                   |
| 7 | 包 `ops-ptc-2.0.5.tgz` SHA256 `d673ca2f…4498f3`，28 个文件，生产安装验收 rc=0                                                       | §8                   |

---

## 1. 报告索引

| 文件                                   | 内容                                 | 状态             |
| ------------------------------------ | ---------------------------------- | -------------- |
| `AUDIT_REPORT.md`                    | 2.0.1 正确性审计 F01–F14 + 2.0.5 产物形态审计 | 在包内            |
| `PERFORMANCE_CUMULATIVE.md`          | 2.0.0→2.0.5 累计优化、口径、归因、边界          | 在包内            |
| `HOST_INTEGRATION.md`                | dsh-ops 宿主接线要求与验证边界                | 在包内            |
| `PERFORMANCE_ROUND2/3/4.md`          | 各轮分组报告                             | 仓库内，2.0.5 起不进包 |
| `audit/perf-round5/RECHECK-2.0.4.md` | 2.0.4 复查记录                         | 仓库内            |
| `audit/perf-round6/*.json`           | 两轮 AB/BA 完整样本（含每次迭代的 outcome）      | 仓库内            |
| 本文                                   | 上面全部内容的一次性整合                       | 桌面             |

分组报告移出安装包是 2.0.5 的决定：它们运行时一次都不读，占 tarball 体积近一半。

---

## 2. 正确性审计（2.0.1，F01–F14）

| 编号  | 优先级     | 缺陷 / 风险                                                                        | 修复                                                                                                | 回归                                      |
| --- | ------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------- |
| F01 | 高       | variadic 捕获拼接连丢逗号、注释、空白，产出错误候选；未绑定模板变量未拒绝                                      | 从原始捕获区间提取，空捕获保留空串，未绑定变量报错                                                                         | ast（19）                                 |
| F02 | 高       | 同名符号不同声明形态只命中一部分，歧义编辑可能改错定义                                                    | 汇总全部形态、去重排序、歧义熔断                                                                                  | ast + safety                            |
| F03 | 高       | 只比错误数量，会让修好一处旧错误掩盖一处新错误                                                        | 改按诊断身份 + 偏移映射 + 未改区域比对                                                                            | ast（相同计数/不同错误、位移旧错误）                    |
| F04 | 高       | 多文件跑到后续错误时前面已落盘；写入缺快照/锁/独占临时文件                                                 | 全量预审计 + 协作锁 + 独占随机临时文件 + 前后快照 + 保留 mode + rename                                                  | safety（15）                              |
| F05 | 中       | 多 roots 枚举超全局上限；缓存复用错 limit/截断标记；返回数组污染缓存                                      | 全局去重与上限、cache key 含策略与上限、保留 truncation、克隆结果                                                       | safety（cap2→cap20）                      |
| F06 | 中       | null / 非法 mode / NaN 进入公开路径，可能崩溃或意外 apply                                      | 入口校验 + 早返回；限定 scanBudget / limit                                                                  | safety + pipeline + mode（28）            |
| F07 | 高       | 旧 pipeline 落盘后才审计，解析失败可能已写入                                                    | 同一 snapshot 上先算改写、再审 AST/difftastic 候选、最后提交                                                       | pipeline（22）                            |
| F08 | 高       | 变长文件恢复用 `original.length` 替换当前区间，可能留尾或越界                                       | restore 用当前文件长度 + sha 守护                                                                          | pipeline（grow/shrink + hash 失配）         |
| F09 | 中       | 临时目录 pid/时间命名碰撞；difftastic 抛错路径泄漏临时文件                                          | 随机 `mkdtemp` + `finally` 清理自有目录                                                                   | pipeline                                |
| F10 | 高       | worker stdin/目标/输出无界、弱范围与 hash 校验、临时名碰撞、unsafe copy 分支                         | 16 MiB 输入/目标/输出、10000 edits、上下界与编码校验、强制 64 hex preimage hash、拒绝 `atomic:false`、随机 `wx`、晚 snapshot | worker（16）                              |
| F11 | 中       | stdout 超预算静默返回截断成功；stderr 持续写直到超时                                              | 共享预算，超限立即终止并报 `E_OUTPUT_LIMIT`                                                                    | protocol（38）                            |
| F12 | 中       | MCP null 崩溃、notification 回包、原型 handler、EOF/UTF8 分片、业务错误未标 `isError`、无界输入/在途/输出 | 协议校验；1 MiB 帧、32 在途、8 MiB 应用层输出、严格自有 handler、EOF drain                                             | protocol（38，首版基线 36 项中 32 项失败）          |
| F13 | 高（接入条件） | 自定义 handlers 元数据 ≠ 原包 ToolDefinition；cwd 不构成权限控制                               | 新增 `adapter.ts`、Outcome 转换、真实 ToolRuntime 注册/清理；缺 session/policy/invoke 则关闭执行                     | host-compat 88 条断言 + strict consumer 编译 |
| F14 | 中       | smoke 依赖本机真实项目，固定 10 倍/5 ms 门槛易误报                                              | 自包含四 return fixture，性能改为观测项                                                                       | inproc smoke 18 条                       |

---

## 3. 累计实测：2.0.5 vs 2.0.0

命令：

```bash
node scripts/performance-round2.mjs \
  --baseline audit/perf-round3/baseline-200/package/dist \
  --candidate dist --parity bytes --exclude variadic-html/apply \
  --output audit/perf-round6/comparison-205-vs-200.json
```

`complete=true`，14 场景，`startedAt 2026-10-27T20:06:27Z` → `finishedAt 20:10:15Z`。

| 场景            | 引擎       | 模式      |   冷倍率 | 冷 2.0.0 ms | 冷 2.0.5 ms | 热 2.0.0 ms | 热 2.0.5 ms |        热倍率 |
| ------------- | -------- | ------- | ----: | ---------: | ---------: | ---------: | ---------: | ---------: |
| tiny-4-edits  | inproc   | preview | 1.017 |     162.86 |     160.07 |       0.88 |       0.43 | **2.041x** |
| tiny-4-edits  | inproc   | apply   | 1.007 |     160.89 |     159.80 |       1.82 |       1.93 | **0.944x** |
| tiny-4-edits  | pipeline | preview | 0.858 |     294.80 |     343.47 |     229.62 |     166.45 | **1.379x** |
| tiny-4-edits  | pipeline | apply   | 0.889 |     375.50 |     422.31 |     305.92 |     251.86 |     1.215x |
| large-1500    | inproc   | preview | 1.096 |     265.49 |     242.14 |      89.00 |      13.65 | **6.518x** |
| large-1500    | inproc   | apply   | 1.085 |     266.33 |     245.48 |      89.89 |      16.46 | **5.463x** |
| large-1500    | pipeline | preview | 0.932 |     598.06 |     641.95 |     521.58 |     424.14 | **1.230x** |
| large-1500    | pipeline | apply   | 0.911 |     663.78 |     728.31 |     598.69 |     509.13 |     1.176x |
| many-750      | inproc   | preview | 1.230 |     338.67 |     275.33 |     154.53 |      35.87 | **4.307x** |
| many-750      | inproc   | apply   | 1.240 |     342.64 |     276.34 |     134.51 |      34.76 | **3.869x** |
| many-750      | pipeline | preview | 0.995 |    2238.28 |    2248.93 |    2173.44 |    2056.14 |     1.057x |
| many-750      | pipeline | apply   | 0.986 |    2309.18 |    2341.14 |    2241.26 |    2199.89 |     1.019x |
| variadic-html | inproc   | preview | 0.957 |     152.64 |     159.42 |       0.42 |       0.33 |     1.247x |
| locate-only   | inproc   | locate  | 1.003 |      88.61 |      88.32 |      23.84 |       8.52 | **2.800x** |

`variadic-html / inproc / apply` 被显式排除（记录在 `excluded`）：2.0.0 的 variadic 捕获会丢逗号与注释（F01），该路径 2.0.0 的输出字节与现在不同，不能当字节基线。

### 口径（不读这段数字会被误用）

- 串行交替 AB/BA；冷路径 5 个全新进程；热路径 2 次预热 + 9 次采样取中位。
- 每一对 A/B 都在同一次运行、同一进程内交替，**倍率只在同一次运行内有效，绝对值不可跨运行比较**（历史上出现过同场景绝对值差 3~5 倍、倍率不变）。
- 比较范围：全部公开返回字段 + 落盘实际字节（preview 比对原文件未变；apply 与独立字节 oracle 比对）。
- 对 2.0.0 用 `--parity bytes` 的原因：2.0.0 的 `nodesAdded/kinds` 对 `parenthesized_expression` 有已知少计（F03 修复），只比字节这一可独立证伪的产物。`return ($A);` 场景下独立 oracle 数出 `nodesAdded=15`，2.0.0 报 5，2.0.5 报 15。

---

## 4. 两个倒退点的收敛轨迹

| 点                               | 2.0.1 | 2.0.2（出问题） |  2.0.3 |  2.0.4 | 2.0.5 对 2.0.0 |
| ------------------------------- | ----: | ---------: | -----: | -----: | ------------: |
| tiny-4-edits / inproc / preview | 1.000 | **0.911x** | 1.868x | 2.204x |    **2.041x** |
| large-1500 / pipeline / preview | 1.000 | **0.856x** | 1.225x | 1.396x |    **1.230x** |

两次倒退都不是算法变慢，是新增的正确性开销没控住：

- inproc 侧：每个命中跨 N-API 读一次 `range()`（O(n log n) 次 FFI）、每个命中重解一次模板、整文件被复制多次。
- pipeline 侧：每个 edit 从文件头重新解码 UTF-8 前缀（750 处改写退化成 O(n×m)），以及为「语法是否成立」白算 hunk/kind 统计。

2.0.3 改成「一次取、一次解、只算必要项」，2.0.4 把「同一份源码解析两遍」压成一遍（有界整树缓存 + `auditAst` 复用根），2.0.5 去掉模板 EOL 归一的逐命中 `replace` 与零收益的分配。

---

## 5. 仍低于 1.0 的三处：归因，不是漏改

### 5.1 `tiny-4-edits / inproc / apply` 0.944x（1.82 → 1.93 ms）

阶段归因（147 字节 fixture，120 次中位，同进程）：

| 阶段             |                          中位 |
| -------------- | --------------------------: |
| 整次 apply       |              1.747~1.871 ms |
| `checkedWrite` | 1.150~1.367 ms（**66%~73%**） |
| `auditAst`     |                    0.114 ms |
| `inprocLocate` |                    0.169 ms |

差值全部落在写入屏障：2.0.0 的 apply 没有协作锁、没有独占临时文件、没有前后双快照，直接覆盖原文件——这正是 2.0.1 F04 修掉的问题。再往上只能删原子写，即恢复「中途失败可留半截文件」。**没做。**

### 5.2 pipeline 冷路径 0.855~0.995

同一次运行里 pipeline 热路径是 1.03~~1.41x，冷路径反向，差 45~~52 ms，且只在 pipeline 出现（inproc 冷路径 0.988~1.240）。实测一次冷探测：

```
probe 0 true 50.9 ms    # 首次：pickBin + stat + spawn difft --version
probe 1 true  4.2 ms    # 身份缓存命中，只重做 stat
probe 2 true  3.6 ms
```

50.9 ms 与残差同量级、同方向。这笔钱是 2.0.3 为「difftastic 不可用时零临时文件」加的探测。已把它提前到与定位/改写并发（`pipeline.ts:116`），冷路径从 0.825/0.832/0.903/0.888/0.954/0.970 抬到 0.855/0.880/0.933/0.914/0.991/0.972。**没删**——删掉等于让缺工具的请求先写两份候选再失败。

### 5.3 `many-750 / pipeline / apply` 1.019x

2.09 s 里 1.78 s 是 difftastic 的图对齐（131 KB × 2、750 处改写），与实现无关。相对 2.0.0 的增量是 2.0.1 起强制的前置审计（F07），约 25~30 ms。

---

## 6. 2.0.5 精简与产物形态

约束：**不删功能、不改语义、不改任何公开返回字段**。

### 6.1 体积 134165 → 65313 字节（−51.3%）

按单项 gzip 贡献分（tarball 整体压缩，分项之和大于文件本身）：

| 类别                                     | 2.0.4 | 2.0.5 |                 变化 |
| -------------------------------------- | ----: | ----: | -----------------: |
| `dist/`                                | 62303 | 49759 | **−12544（−20.1%）** |
| `audit/perf-round{2,3,4}/summary.json` | 48506 |     0 |             −48506 |
| `PERFORMANCE_ROUND2/3/4.md`            | 10953 |     0 |             −10953 |
| `SMALL_TREE.md`                        |  5952 |     0 |              −5952 |
| `vendor/README.md`                     |   557 |     0 |               −557 |
| 文档与元数据                                 | 22711 | 26426 |              +3715 |

解包 204133 字节。移走的全是研发产物：运行时一次都不读的基准样本、分组报告、文件枚举说明。

### 6.2 两项改动

1. **`files` 白名单收口**：只留 `dist` + README / AUDIT_REPORT / HOST_INTEGRATION / PERFORMANCE_CUMULATIVE。
2. **两遍 emit**（`scripts/build.mjs:28-29`）：第一遍 `--removeComments` 出无注释 `.js`；第二遍 `--emitDeclarationOnly` 重出**保留 JSDoc** 的 `.d.ts`。单跑 `--removeComments` 会连类型文档一起删——那是 DX 损失。

### 6.3 正则预编译

| 位置                                  | 原写法                              | 改动            | 等价理由                                                                                        |
| ----------------------------------- | -------------------------------- | ------------- | ------------------------------------------------------------------------------------------- |
| `inproc.ts:32-45`                   | 12 个内联字面量                        | 提到模块层 `RE_*`  | 字面量每次求值新建 RegExp 包装对象；带 `g` 的只出现在 `match`/`replace`/`matchAll`，三者按规范入口归零 `lastIndex`，无跨调用状态 |
| `inproc.ts:369`                     | `file.match(/[\\/]/g).length`    | 按 charCode 计数 | 只要个数，不必分配匹配数组                                                                               |
| `inproc.ts:390`                     | `rank` 在 `sort` 比较器内重算           | 先打分再排序，按原索引兜底 | 省 O(n log n) 次重复打分，稳定性与原 `Array#sort` 一致                                                    |
| `inproc.ts:802`                     | 每命中无条件 `.replace(/\r?\n/g, eol)` | 先判是否含对应换行     | LF 目标仅当含 `\r` 才可能变，CRLF 目标仅当含 `\n` 才可能变；不满足时结果与原串完全相同                                       |
| `expandTemplate`                    | `parts.map().join('')`           | 累加拼接          | 输出一致，省一个中间数组                                                                                |
| `proc.ts:224-229`、`stages.ts:22-23` | 行切分每次重建                          | 模块层常量         | 同上                                                                                          |

### 6.4 产物形态三条判据（`scripts/dist-shape-regression.mjs`）

1. 去注释只发生在 `.js`：11 个运行时文件无块注释；`.d.ts` 逐份断言 JSDoc 仍在（8 份有内容）。
2. 公开导出集合不变：`dist` 每个可加载模块的导出键与冻结的 2.0.4 构建逐一比对（`cli`/`mcp` 顶层接管 stdio，需不同进程 require）。
3. 包内容契约：`files` 白名单固定五项；消费端额外断言 `audit/`、`scripts/`、`src/` 与分组报告不在包内，且 `dist` 解包 < 200 KiB。

功能等价由 15 个固定场景的完整返回字段 + 落盘字节比对证明（`comparison-205-vs-204.json`），不是靠人工 review 推断。

---

## 7. 2.0.5 vs 2.0.4（精简不能带来性能损失）

`complete=true`，15 场景，全部 `equality: true`。

| 场景            | 引擎       | 模式      |   冷倍率 | 热 2.0.4 ms | 热 2.0.5 ms |    热倍率 |
| ------------- | -------- | ------- | ----: | ---------: | ---------: | -----: |
| tiny-4-edits  | inproc   | preview | 1.105 |       0.49 |       0.47 | 1.044x |
| tiny-4-edits  | inproc   | apply   | 1.012 |       1.89 |       1.76 | 1.071x |
| tiny-4-edits  | pipeline | preview | 0.988 |     164.17 |     163.50 | 1.004x |
| tiny-4-edits  | pipeline | apply   | 0.944 |     242.33 |     244.83 | 0.990x |
| large-1500    | inproc   | preview | 1.029 |      14.98 |      14.98 | 1.000x |
| large-1500    | inproc   | apply   | 1.016 |      16.86 |      16.80 | 1.004x |
| large-1500    | pipeline | preview | 0.992 |     449.26 |     444.21 | 1.011x |
| large-1500    | pipeline | apply   | 1.022 |     531.76 |     540.42 | 0.984x |
| many-750      | inproc   | preview | 1.007 |      35.12 |      34.96 | 1.005x |
| many-750      | inproc   | apply   | 1.001 |      37.75 |      36.04 | 1.047x |
| many-750      | pipeline | preview | 0.980 |    2054.48 |    2059.40 | 0.998x |
| many-750      | pipeline | apply   | 1.001 |    2121.62 |    2150.19 | 0.987x |
| variadic-html | inproc   | preview | 0.981 |       0.41 |       0.41 | 1.003x |
| variadic-html | inproc   | apply   | 1.037 |       1.83 |       1.76 | 1.043x |
| locate-only   | inproc   | locate  | 1.000 |       7.98 |       8.44 | 0.946x |

热路径 10/15 ≥ 1.0，其余 5 项在 −5.4%~~−0.2%。`locate-only` 首轮 0.946x 经独立复跑为 **1.037x**（`audit/perf-round6/recheck-locate.json`），判定为噪声。冷路径的 0.944~~0.980 同样是探测与进程启动抖动，与 2.0.4 同一口径。


结论：精简没有带来可测的性能回退。

---

## 8. 验收与包

| 入口                        | 结果   | 内容                                                                                    |
| ------------------------- | ---- | ------------------------------------------------------------------------------------- |
| `npm run verify`          | rc=0 | typecheck + build + 3 个 smoke + 12 段回归（`audit/perf-round6/final2.log`，**154 行 PASS**） |
| `npm run test:regression` | rc=0 | **280 项** PASS                                                                        |
| `npm run test:perf`       | rc=0 | 347 项审计差分 + 36 组定位/改写差分（**383 项**）                                                    |
| `npm run smoke:package`   | rc=0 | 生产安装（omit=dev / ignore-scripts）+ 消费端 5 项，含精简契约与 `dist < 200 KiB` 守护                   |
| `npm run test:host`       | rc=0 | 真实 dsh-ops 0.4.1，88 条断言 + strict consumer 编译                                          |
| `git diff --check`        | rc=0 | —                                                                                     |

回归分布（280 项）：

| 脚本                            |      项数 |
| ----------------------------- | ------: |
| safety-regression             |      15 |
| ast-regression                |      19 |
| worker-regression             |      16 |
| protocol-regression           |      38 |
| pipeline-regression           |      22 |
| mode-audit-regression         |      28 |
| audit-root-cache-regression   |      11 |
| safe-write-cleanup-regression |       3 |
| pipeline-perf-regression      |       7 |
| deep-inproc-regression        |      36 |
| locate-parity-regression      |      84 |
| dist-shape-regression         |       1 |
| **合计**                        | **280** |

另有 smoke：pipeline 7 例、MCP 5 例、inproc 18 例。

### 包

| 项      | 值                                                                   |
| ------ | ------------------------------------------------------------------- |
| 文件     | `ops-ptc-2.0.5.tgz`                                                 |
| 大小     | 65313 字节（解包 204133）                                                 |
| SHA256 | `d673ca2fa0e4dff7b3281058f684f63767d2920caa742828e0ccca02c04498f3`  |
| 文件数    | 28（11 个 `.js` + 1 个 `.cjs` + 11 个 `.d.ts` + `package.json` + 4 份文档） |
| 重复构建   | 哈希一致                                                                |

包内文档：`README.md`、`AUDIT_REPORT.md`、`PERFORMANCE_CUMULATIVE.md`、`HOST_INTEGRATION.md`。

### 版本历史与体积

| 版本    |   tarball | 主题            |
| ----- | --------: | ------------- |
| 2.0.0 |     49326 | 基线            |
| 2.0.1 |     67466 | 正确性审计 F01–F14 |
| 2.0.2 |     76901 | 性能第一轮         |
| 2.0.3 |    103730 | 消灭两处倒退        |
| 2.0.4 |    134165 | 同一份源码不再重复解析   |
| 2.0.5 | **65313** | 包精简 + 正则预编译   |

---

## 9. 边界（未因优化缩小）

1. **冷启动没有实质变快**：pipeline 冷路径仍比 2.0.0 慢 1.5%~14.5%，原因见 §5.2。
2. **树缓存按进程存活**，键是完整源码，>4 MiB 的文件实际不缓存。
3. **外部工具成本未动**：difftastic 与 ast-grep 的耗时由它们自己决定，没有为了数字删掉独立审计。
4. **并发不是 CAS**：合作方同名锁可互斥，前后快照能拒绝已观察到的变更；不合作的外部 writer 仍有最后检查与 `rename` 之间的竞态窗口。
5. **多文件不是事务**：中途写入失败可部分成功，必须核实 `committed` / `partial`，不能宣称自动全局回滚。
6. **解析 ≠ 语义**：`parseDiagnostics` 不做类型或业务校验；tree-sitter 容错解析可能漏错。
7. **BOM 仍 fail-closed**：带 BOM 的源码报 `E_AST_AUDIT_SPLICE`，功能缺失未修。
8. **枚举 ≠ 完整搜索**：自动策略、上限、30 秒缓存、启发式预筛与预算都会剪枝。
9. **资源上限分层**：worker 16 MiB；MCP 单帧 1 MiB、在途 32、应用层输出 8 MiB；Windows 同步 pipe 可能在 write 内阻塞，`writableLength` 不提供慢 reader 超时保证。
10. **崩溃锁与目录竞态**：硬杀可能留 stale lock，当前不按时间抢锁；父目录 symlink/junction 替换不在保护范围。
11. **元数据保留有限**：保留 mode 不等于保留 ACL、ADS、扩展属性、owner 或全部时间戳。
12. **取消能力有限**：adapter 派发前检查取消，超时声明不等于能硬停同步进程内工作。
13. **平台未验收**：Node 18 / Linux / macOS 未测。
14. **可信宿主桥未接线**：adapter 通过真实接口与注册测试，但不能把裸 handler 绑定 invoke 冒充沙箱。

---

## 10. 复现命令

```bash
cd K:/ai/ops-ptc

# 正确性
npm run verify
npm run test:host -- --ops-root OPS_ROOT --host-root HOST_NODE_MODULES

# 性能差分
npm run test:perf

# 2.0.5 vs 2.0.4（15 场景，字段与字节）
node scripts/performance-round2.mjs \
  --baseline audit/perf-round6/baseline-dist --candidate dist \
  --output audit/perf-round6/comparison-205-vs-204.json

# 2.0.5 vs 2.0.0（14 场景，字节）
node scripts/performance-round2.mjs \
  --baseline audit/perf-round3/baseline-200/package/dist --candidate dist \
  --parity bytes --exclude variadic-html/apply \
  --output audit/perf-round6/comparison-205-vs-200.json

# 产物形态
node scripts/dist-shape-regression.mjs

# 打包与生产安装验收
npm pack
npm run smoke:package
```

单场景定向复跑加 `--case <名字> --engine <inproc|pipeline>`，会给 `partial: true` 的部分报告。

---

本文所有数字取自 `audit/perf-round6/final2.log`、`comparison-205-vs-204.json`、`comparison-205-vs-200.json`、`recheck-locate.json` 与包内 `sha256sum` / `tar -tf` 实测，未做人工改写。
