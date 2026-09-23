// tree-brute.cpp — 独立暴力解（本轮诊断专用）：状态空间 BFS，零优化、只求正确
// 语义（严格照题面）：选一个节点 u，令 s = u 的所有直接孩子的当前值之和，
// 把 x_u 改成 (x_u + s) % b_u；可执行任意次；求所有节点值之和的最大值。
// 只在小数值（b 小）时可行 —— 这正是"暴力解需要小数值数据"的原因。
#include <bits/stdc++.h>
using namespace std;

int main() {
    int T;
    if (scanf("%d", &T) != 1) return 0;
    while (T--) {
        int n;
        scanf("%d", &n);
        vector<long long> a(n + 1), b(n + 1);
        for (int i = 1; i <= n; i++) scanf("%lld", &a[i]);
        for (int i = 1; i <= n; i++) scanf("%lld", &b[i]);
        vector<vector<int>> g(n + 1);
        for (int i = 0; i < n - 1; i++) {
            int u, v; scanf("%d %d", &u, &v);
            g[u].push_back(v); g[v].push_back(u);
        }
        vector<vector<int>> ch(n + 1);
        vector<int> par(n + 1, 0);
        vector<int> st{1}; par[1] = -1;
        while (!st.empty()) {
            int u = st.back(); st.pop_back();
            for (int v : g[u]) {
                if (v == par[u]) continue;
                par[v] = u; ch[u].push_back(v); st.push_back(v);
            }
        }
        vector<long long> init(n + 1);
        for (int i = 1; i <= n; i++) init[i] = a[i];
        set<vector<long long>> seen;
        queue<vector<long long>> q;
        seen.insert(init); q.push(init);
        long long best = 0;
        for (int i = 1; i <= n; i++) best += init[i];
        while (!q.empty()) {
            vector<long long> x = q.front(); q.pop();
            long long sum = 0;
            for (int i = 1; i <= n; i++) sum += x[i];
            best = max(best, sum);
            for (int u = 1; u <= n; u++) {
                long long s = 0;
                for (int v : ch[u]) s += x[v];
                if (s == 0) continue;
                vector<long long> nx = x;
                nx[u] = (x[u] + s) % b[u];
                if (seen.insert(nx).second) q.push(nx);
            }
        }
        printf("%lld\n", best);
    }
    return 0;
}
