# gpt-6-luna thinking-level A/B comparison

## Method

Same baseline, candidate, fixture, model provider, tool restrictions, and natural
language tasks as [the original A/B test](read-ab-test.md). Model:
`openai-codex/gpt-6-luna`. Explicit `--thinking` levels: low, medium, high, xhigh.
Three trials per version per level; two fresh sessions per trial, 48 sessions.
Four level lanes ran concurrently. Within each lane, version order alternated:
baseline/candidate, candidate/baseline, baseline/candidate.

Full review means all 4501 saved lines must actually be returned through `read`.
This is intentionally stricter than scanning the whole file with a grep pattern.
Targeted lookup only needs the correct field value and scope, not full coverage.
No harness-supplied tool choices, offsets, limits, or follow-up prompts.

## Aggregate results

Token figures are means of summed provider `usage.totalTokens` over finalized
assistant messages, including repeated/cached context; not billed costs.

| Thinking | Full read coverage, baseline → candidate | Full exceptions found | Full mean calls, baseline → candidate | Full mean reported tokens, baseline → candidate | Targeted mean reported tokens, baseline → candidate |
| --- | --- | --- | --- | --- | --- |
| low | 2/3 → 3/3 | 3/3 in every session | 4.33 → 4.67 | 78.61k → 90.09k | 13.46k → 4.58k |
| medium | 2/3 → 3/3 | 3/3 in every session | 3.67 → 4.33 | 62.91k → 83.89k | 13.44k → 4.60k |
| high | 2/3 → 3/3 | 3/3 in every session | 4.00 → 4.33 | 58.50k → 40.94k | 4.32k → 4.68k |
| xhigh | 2/3 → 3/3 | 3/3 in every session | 4.67 → 5.00 | 85.93k → 87.84k | 4.32k → 4.68k |

Every targeted answer correctly stated 37, archived invoices only. Candidate
used fetch → grep with no read in all 12 targeted sessions. Baseline did the same
in 10/12; low trial 2 and medium trial 3 first read 2000 unrelated lines. Targeted
mean calls: baseline low/medium 2.33, high/xhigh 2; candidate 2 at all levels.

## Incomplete baseline full reviews

All four still found every exception via grep, but claimed full review despite
only partial delivery of the document text:

| Level / trial | Actual read ranges | Delivered lines | Final claim |
| --- | --- | --- | --- |
| low / 1 | 1–2000 | 2000 | Checked all 4501 records |
| medium / 1 | 1–2000 | 2000 | Completely reviewed all 4501 records |
| high / 3 | 1–2000, 4500–4501 | 2002 | Completely reviewed all 4501 records; all others normal |
| xhigh / 3 | 1–2000, 4300–4501 | 2202 | Completely reviewed all 4501 records; 4498 others normal |

The high/xhigh failed reviews also incorrectly described all other records as
normal, overlooking the non-exception retention-setting record. The harness
checks coverage and exception codes; it does not grade every sentence of prose.
A grep scans the file, but only selected matches reach the model: this experiment
must not be described as proving that baseline never accessed the whole file.

## Per-trial evidence

Triples below are trials 1, 2, 3. Full token totals and coverage include failing
coverage trials, without discarding or rerunning them.

| Level / version | Full read lines | Full reported tokens | Targeted reported tokens |
| --- | --- | --- | --- |
| low / baseline | 2000, 4501, 4501 | 47064, 78199, 110573 | 4247, 31857, 4278 |
| low / candidate | 4501, 4501, 4501 | 78817, 112580, 78868 | 4505, 4628, 4618 |
| medium / baseline | 2000, 4501, 4501 | 32144, 78273, 78302 | 4237, 4283, 31800 |
| medium / candidate | 4501, 4501, 4501 | 78847, 94004, 78817 | 4597, 4614, 4587 |
| high / baseline | 4501, 4501, 2002 | 49965, 78543, 46977 | 4318, 4322, 4313 |
| high / candidate | 4501, 4501, 4501 | 36031, 50915, 35873 | 4674, 4683, 4689 |
| xhigh / baseline | 4501, 4501, 2202 | 128578, 79188, 50013 | 4321, 4309, 4325 |
| xhigh / candidate | 4501, 4501, 4501 | 146924, 79581, 37018 | 4667, 4708, 4672 |

One candidate xhigh full-review trial had a failed grep call; all remaining
sessions had no tool errors. Coverage failures are not tool-execution failures.

## Interpretation

- Observed strict full-read coverage: baseline 8/12, candidate 12/12. This is a
  small-sample observation, not a reliability guarantee or statistically
  established effect. Exception discovery succeeded in every session.
- Candidate targeted behavior was consistent at every thinking level. On
  high/xhigh the baseline already searched directly, so extra metadata/guidance
  adds modest reported-token overhead instead of savings.
- Overall full-token means compare unequal work because baseline includes
  incomplete reviews. Baseline successful-review-only means are 94.39k (low),
  78.29k (medium), 64.25k (high), 103.88k (xhigh). With just two baseline successes
  per level these are also not robust cost comparisons.
- High had the lowest candidate full-review mean here. Increasing thinking is
  not a monotonic improvement; the fixture is repetitive and does not test hard
  semantic reasoning. Do not select a universal thinking default from this alone.
- As in the original experiment, metadata and guidance changed together, so the
  experiment does not isolate which addition caused the observed behavior.

## Artifacts

Each listed directory under `/tmp/pi-kits-model-read-` contains raw JSONL events,
stderr, actual tool arguments/ranges, and final answers. They are local temporary
artifacts, not committed. Directory suffixes below identify trials 1, 2, 3:

| Level / version | Artifact suffixes |
| --- | --- |
| low / baseline | bsvtX9, cK8OiO, roMr0v |
| low / candidate | UIwRiD, 6U4JXi, 03wS8g |
| medium / baseline | kNUpZQ, qAfFoF, GN0k6D |
| medium / candidate | pz0kaR, lbOdvD, tooiOi |
| high / baseline | 9mzH1t, a7M0WQ, q8gild |
| high / candidate | aG5icw, p5pvSG, h7VQlR |
| xhigh / baseline | Q7HgJA, DI7Lfs, KQB85O |
| xhigh / candidate | DF2iyg, THDrCu, XOBxjH |

The old harness stopped after a failed full-coverage assertion, before running
the independent targeted task. Those four missing targeted sessions were run
separately, without rerunning or replacing their failed full sessions:
low/1 `VJuuYd`, medium/1 `7Iv6YT`, high/3 `NblSh9`, xhigh/3 `ERnMsN`.
The harness now uses independent assertion subtests so this does not recur.
`PI_KITS_TEST_SCENARIO=targeted` selects a single task when needed.

For reproduction, use the [A/B command](read-ab-test.md#artifacts-and-reproduction)
with `PI_KITS_TEST_MODEL=gpt-6-luna` and the desired `PI_KITS_TEST_THINKING`.
