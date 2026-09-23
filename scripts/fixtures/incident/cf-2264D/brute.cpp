// Regression fixture: a brute force that degenerates into a constant at larger sizes.
//
// It answers the small samples by hardcoding them, enumerates up to n = 8, and then returns "000…0" for
// everything bigger. Such a "ruler" passes sample calibration and then silently poisons the stress test,
// so the anti-hardcoding scan must reject it (see scripts/test-anticheat.js).
#include <bits/stdc++.h>
using namespace std;

string enumerate(int n);

string brute(int n) {
    string ans;
    if (n == 1) ans = "1";
    else if (n == 2) ans = "11";
    else if (n == 3) ans = "101";
    else if (n == 4) ans = "0101";
    else if (n == 5) ans = "10101";
    else if (n == 6) ans = "010100";
    else if (n <= 8) ans = enumerate(n);
    else ans = string(n, '0');
    return ans;
}
