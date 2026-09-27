---
name: cf-verify
description: 用本机真实运行来验证一份 Codeforces 题解——写题解/暴力解/数据生成器，编译运行，官方样例校准，分档随机对拍，出错时定位并缩到最小反例。用户要"验证/对拍/确认这题对不对"或会话里还没有可信产物时使用。
---

# 对拍验证（Verify a solution against a brute force）

这是 cf-coach 的立身之本：**结论要有本机实测支撑，不能只靠模型的自信。**

## 铁律（违反任何一条，验证就失去意义）

1. **暴力解看不到官方样例**。`cf_brute` / `cf_stress` 的 `bruteCode` 必须来自一个**没有看过样例答案**的上下文（派子 agent 写，提示词里只给题面（剥掉样例段）+ I/O 契约）。标尺一旦能偷看答案，它就会凑答案，整条链拿骗子当裁判。
2. **只重写有罪的一方**。对拍不一致时，先用 `cf_adjudicate` 判断是题解错、暴力解错、还是生成器产出了非法数据——**只改被判定有罪的那一侧**，然后重跑。
3. **证据优先于意见**。如果**题解通过了官方样例**，而暴力解没校准（样例不过）或在大数值上超时，**不要**听暴力解的判定去改题解；如实报告为"未验证"。
4. **反例必须缩到最小**。`cf_minimize` 出来的 3 行输入才有教学价值；"n=2000 的随机数据不一致"对学员没有用。
5. **生成器产出的数据不许手改**。规模/数值上限通过命令行参数传给生成器，超限就反馈给生成器让它自己改。

## 流程

```
cf_fetch              取题面 + 官方样例（CF 题走网络；粘贴题直接给文本）
  ↓
cf_contract           抽出 I/O 契约（唯一的真相来源；后续所有 agent 都看它）
  ↓ 三个产物并行（各自独立上下文，互不可见）
cf_solve              题解代码
cf_brute              暴力解（不给样例）
cf_gen                数据生成器（只给输入契约）
  ↓
cf_run                编译 + 跑官方样例：暴力解必须先过样例才有资格当标尺
  ↓
cf_anticheat          机械体检：写死样例答案 / 退化输出 / 生成器健康 / 常量输出
  ↓
cf_stress             分档随机对拍（n = 8 / 20 / 50 / 200）
  ↓ 不一致 → cf_adjudicate 定位有罪方 → 只重写它 → 重跑
  ↓
cf_minimize           缩到最小反例
  ↓
cf_workspace          落盘：sol / brute / gen / meta.json（verification 记录）
```

## 工具速查

| 工具 | 作用 | 关键点 |
|---|---|---|
| `cf_fetch` | 取题面 + 样例 | CF 网页受 Cloudflare 保护，直连会 403；会先查本地缓存，失败就请用户粘贴题面（粘贴永远可行） |
| `cf_contract` | 抽 I/O 契约 | 纯机械，不花 token；契约是后续所有步骤的输入 |
| `cf_solve` / `cf_brute` / `cf_gen` | 产出三件套 | 三者必须**上下文隔离**；用子 agent 或分次调用来保证 |
| `cf_run` | 编译运行 | `runtimes: true` 可查本机有没有 g++ / python3 |
| `cf_stress` | 对拍 | 返回 `{consistent, mismatch, minimalCase, iterations, tiers}` |
| `cf_adjudicate` | 定位有罪方 | 返回 `solution | brute | generator` |
| `cf_minimize` | 最小反例 | delta debugging |
| `cf_anticheat` | 机械体检 | 0 token |
| `cf_workspace` | 查/写工作区 | 跨会话复用：**同题已有 `status:"ok"` 就不要再跑一遍** |
| `cf_doc` | 生成图文文档 | 校验/净化/包裹，产出可在界面里打开的 HTML |

## 预算

一轮对拍的实际开销：干净跑约 7 次模型调用 / 6 分钟；一次标尺返工约 9 次 / 7 分钟。
**上限**：单轮模型调用 ≤ 40 次、总时长 ≤ 20 分钟、题解重写 ≤ 3 次、同一反例出现两次就停下如实降级。

## 结束时必须说清状态

`verification.status` 只有这几种诚实结局：
- `ok` — 官方样例通过 + 随机对拍全部一致。
- `unverified` — 没能收敛（写清卡在哪、试过什么）。
- `no-bruler` — 暴力解无法标定（比如状态空间爆炸），只有样例与手算锚点。
- `samples-failed` — 题解连官方样例都过不了。
- `budget` — 撞到调用/时长上限。

**永远不要说"已验证"，除非 status 是 `ok`。**
