import random
import sys

# tree-gen.py — 诊断专用生成器：n <= argv[1]，**所有数值 <= argv[2]**（小数值才能让暴力解跑得动）
maxN = int(sys.argv[1]) if len(sys.argv) > 1 else 5
maxV = int(sys.argv[2]) if len(sys.argv) > 2 else 6
random.seed()

t = random.randint(1, 2)
print(t)
for _ in range(t):
    n = random.randint(1, max(1, maxN))
    print(n)
    b = [random.randint(1, max(1, maxV)) for _ in range(n)]
    a = [random.randint(0, b[i] - 1) for i in range(n)]
    print(*a)
    print(*b)
    for v in range(2, n + 1):
        u = random.randint(1, v - 1)
        print(u, v)
