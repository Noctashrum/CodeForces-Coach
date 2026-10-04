# 题面放这里（`statements/<题号>.txt`）

这些文件**不会进 git**（`.gitignore` 里有 `ablation/statements/*.txt`）：题面是 Codeforces 的内容，
而且体积不小。请自己准备，两种来源都行：

1. **从 cf-coach 里导出**（最省事）：在 cf-coach 里对这道题点一次「从 CF 获取题面」，
   然后把输入框里那段题面复制出来，存成 `statements/<题号>.txt`。
2. 自己在浏览器里打开题目页复制正文（记得保留 输入格式/输出格式/样例 这几节）。

要求：

- 每个文件对应 `problems.json` 里那条题目的 `statement` 字段；
- **三档必须用同一份文本**（脚本会把文本的 sha256 记进 `records.jsonl`，这就是"信息预算对齐"的证据）；
- 样例最好也抄进 `problems.json` 的 `samples` 里（判分第一关用），格式是 `{"input": "...", "output": "..."}`。
