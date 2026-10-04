import sys

def main():
    data = sys.stdin.read().split()
    a, b = int(data[0]), int(data[1])
    print(a + b)

main()
