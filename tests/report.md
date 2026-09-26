# sys1grep LLM-as-judge report

judge: claude -p --model sonnet / corpus: 51 lines / cases: 10 / 2026-09-19

## 閾値の最適化 (肯定 -t × 否定 -T、0.05 刻み)

- 既定 -t 0.5 -T 0.5: P 0.94 R 0.98 F1 0.957 (TP 88 / FP 6 / FN 2)
- 最良 -t 0.45 -T 0.65: P 0.93 R 1.00 F1 0.963 (TP 90 / FP 7 / FN 0)

上位 8 組:

| -t | -T | P | R | F1 |
|---|---|---|---|---|
| 0.45 | 0.65 | 0.93 | 1.00 | 0.963 |
| 0.4 | 0.65 | 0.93 | 1.00 | 0.963 |
| 0.5 | 0.65 | 0.94 | 0.99 | 0.962 |
| 0.75 | 0.65 | 0.98 | 0.94 | 0.960 |
| 0.45 | 0.7 | 0.92 | 1.00 | 0.957 |
| 0.4 | 0.7 | 0.92 | 1.00 | 0.957 |
| 0.45 | 0.75 | 0.92 | 1.00 | 0.957 |
| 0.4 | 0.75 | 0.92 | 1.00 | 0.957 |

## ケース別 (最良の閾値で評価)

| case | args | judge | sys1grep | P | R |
|---|---|---|---|---|---|
| single/ja-meaning | `-e ネットワークやリモート接続の障害` | 6 | 8 | 0.75 | 1.00 |

  sys1grep のみ (judge は不一致):
  - L5: 2026-09-19 08:02:31 INFO  retrying payment-gateway request (attempt 2/3)
  - L30: except ConnectionError as e:

| single/abstract | `-e the writer expresses gratitude or satisfaction` | 3 | 4 | 0.75 | 1.00 |

  sys1grep のみ (judge は不一致):
  - L47: ぼくのなつやすみは楽しかったです

| single/angry-customer | `-e customer is angry or frustrated` | 5 | 5 | 1.00 | 1.00 |
| or/refund-or-address | `-e customer is asking for a refund -e customer wants to change a delivery address` | 4 | 4 | 1.00 | 1.00 |
| and/net-and-retry | `-e ネットワークやリモート接続の障害 -a a retry is happening or was attempted` | 0 | 1 | 0.00 | 0.00 |

  sys1grep のみ (judge は不一致):
  - L5: 2026-09-19 08:02:31 INFO  retrying payment-gateway request (attempt 2/3)

| andnot/error-not-network | `-e a server log line reporting an error or fatal condition -v the problem is about network connectivity` | 4 | 5 | 0.80 | 1.00 |

  sys1grep のみ (judge は不一致):
  - L11: 2026-09-19 09:00:00 ERROR SSL handshake failed: certificate expired

| ornot/code-or-not-english | `-e source code or SQL -e !written in English` | 23 | 25 | 0.92 | 1.00 |

  sys1grep のみ (judge は不一致):
  - L3: 2026-09-19 08:01:15 WARN  slow query took 3200ms: SELECT * FROM orders
  - L49: API keys must never be committed to the repository.

| not/only-non-log | `-v a timestamped server log line` | 39 | 39 | 1.00 | 1.00 |
| mixed/(finance and negative) or weather | `-e about economy, finance or markets -a the news is negative or a decline -e about weather` | 3 | 3 | 1.00 | 1.00 |
| single/security-risk | `-e a security risk or dangerous destructive operation` | 3 | 3 | 1.00 | 1.00 |
