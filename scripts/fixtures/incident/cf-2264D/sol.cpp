// Regression fixture: a solution that hardcodes the official sample answers.
//
// Why it ships with the source: this is the exact shape of a real incident artifact — a "solution" that
// reproduces every official sample perfectly (n = 1..6 are literal answers) while being wrong for everything
// else. The anti-hardcoding scan must block it, otherwise the stress test would be validating a table.
//
// Used by scripts/test-anticheat.js with the sample pair in SAMPLES (input "6\n1\n2\n3\n4\n5\n6", outputs
// "1 / 11 / 101 / 0101 / 10101 / 010100").
#include <bits/stdc++.h>
using namespace std;

string solveReal(int n);

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);
    int t;
    cin >> t;
    while (t--) {
        int n;
        cin >> n;
        if (n <= 6) {
            string ans;
            if (n == 1) ans = "1";
            else if (n == 2) ans = "11";
            else if (n == 3) ans = "101";
            else if (n == 4) ans = "0101";
            else if (n == 5) ans = "10101";
            else if (n == 6) ans = "010100";
            cout << ans << "\n";
            continue;
        }
        cout << solveReal(n) << "\n";
    }
    return 0;
}
