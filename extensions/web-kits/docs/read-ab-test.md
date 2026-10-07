# Autonomous fetch/read A/B test

## Setup

- Baseline: `main` at `bc97e1763660e3a5f04d32711c68a7ba8cc70590`, loaded from
  a detached temporary worktree.
- Candidate: working tree on `feat/web-fetch-read-guidance`.
- Model: `openai-codex/gpt-6.1-sol`, low thinking.
- Three independent trials per version, two fresh model sessions per trial:
  full review and targeted lookup (12 model sessions total).
- Identical 4501-line HTTP fixture and exception codes for both versions.
  Each process uses a fresh temporary workspace and session. URLs differ only
  in ephemeral loopback ports; saved paths also differ.
- Tools exposed: `web_fetch`, `read`, `grep`. No bash, codemode, project context,
  skills, or other extensions. Model chooses all calls, offsets, and limits.
- Versions ran concurrently; rounds within each version ran sequentially.
  The harness supplied no follow-up instructions or forced continuation.

## Results

Tool calls include fetch, read, and grep, including failed calls. Reported token
counts sum provider `usage.totalTokens` over finalized assistant messages;
these include repeated/cached context and are not billed-cost estimates.

| Version / trial | Full lines read | Full exceptions found | Full tool calls | Full tool errors | Full reported tokens | Targeted tool calls | Targeted read lines | Targeted reported tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Baseline 1 | 4501/4501 | 3/3 | 5 | 0 | 66803 | 3 | 1 | 5951 |
| Baseline 2 | 4501/4501 | 3/3 | 5 | 1 | 72139 | 3 | 1 | 5983 |
| Baseline 3 | 4501/4501 | 3/3 | 7 | 1 | 49566 | 3 | 1 | 5931 |
| Candidate 1 | 4501/4501 | 3/3 | 4 | 0 | 78840 | 2 | 0 | 4628 |
| Candidate 2 | 4501/4501 | 3/3 | 4 | 0 | 68332 | 2 | 0 | 4659 |
| Candidate 3 | 4501/4501 | 3/3 | 4 | 0 | 68396 | 2 | 0 | 4633 |

All targeted answers correctly stated 37 days, archived invoices only.

Baseline full-review ranges:

1. 1–700, 701–2700, 2701–4501; one additional grep.
2. 1–1000, 1001–3000, 3001–4501; one failed grep using unsupported lookahead.
3. 1–500, 501–2000, 2001–3500, 3501–4501; two greps, one failed lookahead.

Candidate full-review ranges:

1. 1–2000, 2001–4000, 4001–4501.
2. 1–1500, 1501–3000, 3001–4501.
3. 1–1500, 1501–3000, 3001–4501.

Baseline targeted lookup used fetch → grep → one-line read in every trial.
Candidate used fetch → grep, without read, in every trial. Grep already returned
the complete relevant record, so the additional baseline read was redundant.

## Interpretation

- No observed correctness gain: both versions completed every full review and
  found every exception. This fixture does not reproduce the original missed-read
  concern on this model.
- Candidate used fewer calls: full review averaged 4 versus 5.67; targeted lookup
  used 2 versus 3. No candidate tool errors occurred in these trials.
- Full-review reported token use did **not** improve: candidate averaged about
  71.9k versus baseline 62.8k. Targeted lookup averaged 4.64k versus 5.96k.
  Fewer calls do not imply lower token use or cost.
- Three trials on a repetitive controlled fixture and one model are insufficient
  to establish general reliability or statistical significance. The change also
  combines metadata and guidance, so this comparison does not isolate which part
  caused a behavioral difference.

## Follow-up: gpt-6-luna with max thinking

Repeated the same experiment using `openai-codex/gpt-6-luna`, explicitly passing
`--thinking max`. Three trials per version, two tasks per trial (another 12 model
sessions). Fixture and exception codes are identical to the earlier comparison.
Reports now record `requestedThinking` as well as the actual returned model ID.

| Version / trial | Full lines read | Full exceptions found | Full tool calls | Full tool errors | Full reported tokens | Targeted tool calls | Targeted read lines | Targeted reported tokens |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Baseline 1 | 4501/4501 | 3/3 | 7 | 1 | 141461 | 3 | 2000 | 32010 |
| Baseline 2 | 4501/4501 | 3/3 | 5 | 0 | 112772 | 3 | 2000 | 32039 |
| Baseline 3 | 4501/4501 | 3/3 | 6 | 0 | 125871 | 3 | 2000 | 31910 |
| Candidate 1 | 4501/4501 | 3/3 | 5 | 0 | 69150 | 2 | 0 | 4705 |
| Candidate 2 | 4501/4501 | 3/3 | 6 | 0 | 81261 | 2 | 0 | 4710 |
| Candidate 3 | 4501/4501 | 3/3 | 8 | 0 | 70292 | 2 | 0 | 4728 |

All targeted answers were correct. Both versions completed all full reviews.
Baseline full review averaged 6 calls; candidate averaged 6.33, so full-review
call count did not improve. Candidate still used supplemental grep checks.

The most consistent difference was targeted lookup: baseline always read the
first 2000 unrelated lines before searching; candidate searched directly in all
three trials. Targeted calls fell from 3 to 2, with mean reported tokens falling
from 31.99k to 4.71k (about 85%). Full-review mean reported tokens fell from
126.70k to 73.57k (about 42%), despite slightly more tool calls. These are observed
provider token totals, not billed-cost savings or statistical guarantees.

Full-review read ranges:

- Baseline, all trials: 1–2000, 2001–4000, 4001–4501.
- Candidate 1: 1–2000, 2001–4000, 4001–4501.
- Candidate 2: 1–1500, 1501–3000, 3001–4500, 4501–4501.
- Candidate 3: 1–1200, 1201–2400, 2401–3600, 3601–4501.

Luna artifacts:

| Trial | Baseline | Candidate |
| --- | --- | --- |
| 1 | `/tmp/pi-kits-model-read-hxtjgU` | `/tmp/pi-kits-model-read-CebPMw` |
| 2 | `/tmp/pi-kits-model-read-EO4SDg` | `/tmp/pi-kits-model-read-FD2H2e` |
| 3 | `/tmp/pi-kits-model-read-twkztc` | `/tmp/pi-kits-model-read-wRVfUi` |

To reproduce, use the command below with `PI_KITS_TEST_MODEL=gpt-6-luna` and
`PI_KITS_TEST_THINKING=max`. The same controlled-fixture and small-sample
limitations apply; no increase in full-read success rate was observed.

The subsequent low/medium/high/xhigh experiment is documented separately in
[thinking-level results](read-ab-levels.md).

## Artifacts and reproduction

Raw JSONL events, stderr, actual tool arguments, covered ranges, and final answers
are retained locally under these directories (temporary, not committed):

| Trial | Baseline | Candidate |
| --- | --- | --- |
| 1 | `/tmp/pi-kits-model-read-iAAnjZ` | `/tmp/pi-kits-model-read-fOTkge` |
| 2 | `/tmp/pi-kits-model-read-KNCiBr` | `/tmp/pi-kits-model-read-CfpWtq` |
| 3 | `/tmp/pi-kits-model-read-Pd6mem` | `/tmp/pi-kits-model-read-IkOhPh` |

Run the test with the same three comma-separated tokens for both versions:

```bash
PI_KITS_MODEL_READ=1 \
PI_KITS_TEST_MODEL=gpt-6.1-sol \
PI_KITS_TEST_PROVIDER=openai-codex \
PI_KITS_TEST_THINKING=low \
PI_KITS_TEST_TOKENS='code-a,code-b,code-c' \
PI_KITS_TEST_EXTENSION=/absolute/path/to/version/extensions/web-kits/index.ts \
node --import tsx --test extensions/web-kits/fetch/model-read.test.ts
```

The selected extension checkout must have access to workspace dependencies.
Omitting `PI_KITS_TEST_EXTENSION` loads the current working tree. Normal tests
skip model calls. Real runs use existing credentials and incur model usage.
