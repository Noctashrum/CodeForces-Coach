# 消融实验：cf-coach 到底比裸模型强在哪

这套脚本用来回答一个具体问题：**同一批题、同一个模型、同一份题面，加上 cf-coach 的 harness 之后，正确率提升多少、代价是多少 token。**

三档设计（这是当前实现的）：

| 档位 | 是什么 | 有没有工具 | 有没有 harness |
| --- | --- | --- | --- |
| **L0** | 裸模型：题面进去，回答出来 | 无 | 无 |
| **L1** | 裸 agent：同一个工具循环 + 通用工具（写文件/读文件/编译运行/对拍），提示词明确要求它自己对拍 | 有（4 个通用工具） | 无 |
| **L2** | cf-coach 本体：题面整理 → 正解/暴力/生成器三件套 → 对拍 → 证据门 → 图文讲解 | 有（cf_* 全套） | 有 |

> L1 故意复用 `lib/agentloop.js`（和 L2 同一个循环实现）与同一个 `data/config.json` 模型接口。
> 这样 **L2 − L1 才是"harness 的净贡献"**，而不是"谁的循环写得好"。

## 快速开始

```bash
# 0) 零 token 自测：本地假模型 + 自带示例题，验证整条管线（L0/L1/判分）
node ablation/selftest.js

# 1) 准备题目：复制清单，粘贴题面（题面不会进 git）
cp ablation/problems.example.json ablation/problems.json
mkdir -p ablation/statements ablation/oracle
#    statements/1800C.txt        ← 题面正文（从 cf-coach 会话里导出，或自己粘贴）
#    oracle/1800C.cpp            ← 外部 AC 提交（判分标尺，见下面「纪律」）
#    oracle/1800C.gen.cpp        ← 随机数据生成器

# 2) 先跑 5 题 pilot（强烈建议；管线的问题要在 5 题内暴露，别等 30 题）
node ablation/run.js --level L0,L1 --problems all --limit 5 --out ablation/out/pilot

# 3) L2 用 cf-coach 本体跑，然后把它的产物导进同一份记录
node ablation/import-l2.js --conv <会话id> --out ablation/out/pilot

# 4) 统一判分（三档同一套判据）
node ablation/judge.js --out ablation/out/pilot --iterations 200
```

想不花钱把 L0/L1 的管线再走一遍（不判分，只验证脚本）：

```bash
node ablation/mockllm.js --port 3999          # 另开一个终端
node ablation/run.js --base-url http://127.0.0.1:3999/v1 --api-key mock --model mock-gpt-4 --level L0,L1
```

## 产物长什么样

```
ablation/out/<时间戳>/
  records.jsonl       每次运行一行：题面 sha、模型、提示词、工具面、tokens、花费、耗时、最终代码
  answers/*.md        模型原始回答全文（人工复核、写论文附录都用它）
  transcript/*.jsonl  L1 的工具调用流水（时间、工具、参数、结果）——"它到底做了没做对拍"看这里
  sandbox/<name>/     L1 的工作目录（brute/gen/solution 都留着，可复现）
  summary.json        分档汇总：次数、成败、tokens、花费、总耗时
  verdicts.jsonl      判分结果（样例 + 差分），带反例输入
```

## 判分口径（三关）

1. **官方样例**：题目自带样例，跑过才算"至少对样例正确"。
2. **差分对拍**：用外部 AC 提交当标尺，配随机数据生成器，在小数据上跑几百组比对。
   这一关才是真判据 —— **样例是能骗过去的**（`selftest.js` 里就专门放了这样一份代码：
   样例全过、差分必被抓到，用来证明判据真的能判错）。
3. **人工抽检（可选）**：抽 5–10 题人工读代码，看是不是"真解"而不是"特判样例"。

### ⛔ 纪律：oracle 绝不能是 cf-coach 自己产出的

用 L2 自己写的暴力解/题解去评判 L2，等于自证，评审一眼就能否掉。
oracle 只能来自：

- Codeforces 上**真实 AC 的提交**（`lib/cfreview.js`/`cf_source` 已经能抓提交源码）；
- 题解博客里的代码（自己读一遍确认逻辑）；
- 你自己手写并单独验证过的实现。

`gen` 也一样：它决定"能考出什么错"，最好由你手写，而不是让 L2 生成。

## 让结论站得住的五件事

1. **配对（paired）**：同一批题跑齐三档，逐题比较，报告"哪几题从错到对"。
   每题的结局只有 对/错 两种 → 用**符号检验 / McNemar**，别只报一个总正确率。
2. **信息预算对齐**：三档拿到**同一份题面文本**（`statementSha` 记在记录里，能自证）、
   同一个模型、同一个服务商接口。注意一个已核实的事实：`lib/llm.js` 的请求体是
   `{model, stream, messages}` + 可选 `max_tokens`，**不发 temperature**，
   所以采样参数天然一致（记录里的 `requestFingerprint` 也说明了这点）。
3. **把 L1 的工具面写进文档**：L1 允许写文件/运行/对拍，不允许联网取题。
   工具面一变，L1 的含义就变了，结论也必须跟着重述。
4. **成本一起报**："正确率 +30 个百分点"必须配"多花多少 token/多少钱"。
   `summary.json` 里每档都有 tokens 与花费；只报正确率不报成本，等于只讲了一半。
5. **样本量与难度分层**：建议 24–30 题，分三档难度（800–1200 / 1300–1800 / 1900+），
   并混入"阴险题"（多解、精度、大 I/O、构造/交互类）。先 5 题 pilot，再放大。

## 成本与时间（按当前默认模型量级）

| 档位 | 每题调用次数 | 每题 tokens 量级 | 说明 |
| --- | --- | --- | --- |
| L0 | 1 | 数千 | 最快最便宜 |
| L1 | 10–30 | 5 万–15 万 | 主要花在写暴力/生成器与反复对拍 |
| L2 | 十几个子 Agent | 10 万–30 万 | 三件套 + 对拍 + 文档 |

30 题 × 三档大致是**几十元到一两百元**的 token 开销（取决于模型与题面长度），
机器时间几小时，**不需要人工逐题跑**；人工主要花在准备 oracle 与抽检上。

## 这版**没有**做（别误读结论）

- **L1b（提示升级档）**：同样"被要求对拍"，但强调必须自己写暴力解与生成器并跑通 ——
  用来把"提示词的功劳"和"harness 的功劳"分开。目前 L1 已经包含"告诉它对拍"这句提示。
- **自动抓题面/自动抓 AC 提交**：题面与 oracle 目前靠人工准备（`statements/`、`oracle/` 被 .gitignore）。
- **自动统计检验**：判分脚本只输出每档通过率与逐题结果；显著性检验（符号检验/McNemar）请用
  `verdicts.jsonl` 自行计算，或者把结论写成"这 n 题里，L2 把 k 题从错变对、把 m 题从对变错"。
- **非确定性抽样**：同一档同一题只跑一次。若要报方差，用 `--out` 分多个目录跑多次。

## 报告结论的最小模板

```
模型：<provider::model>   题集：<n> 题（难度分层 <…>）   判据：样例 + <k> 组差分（oracle 来自 <来源>）
L0：对 a/n    平均 <p>k tokens   平均 <t>s
L1：对 b/n    平均 <p>k tokens   平均 <t>s
L2：对 c/n    平均 <p>k tokens   平均 <t>s
配对：L2 vs L0 —— 从错到对 <x> 题、从对到错 <y> 题（符号检验 p=<…>）
结论：harness 的净增量 = c − b（L2 vs L1），提示词的增量 = b − a（L1 vs L0）。
```
