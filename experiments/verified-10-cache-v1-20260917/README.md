# Ten-instance cache-stable JevCoder comparison

**Status: complete — all 20 generations and official evaluations finished.** Both arms solved the same **8/10** cases. Recorded-usage cost was **37.99% lower** with cache-stable JevCoder, not halved. This is a fresh paired run with JevCoder 0.2.0 (`stable-prefix-v1`); no prior result is reused as the baseline denominator.

## Results

| Metric | Fresh plain Pi | Cache-stable JevCoder |
| --- | ---: | ---: |
| Officially resolved | **8/10** | **8/10** |
| Astra request starts | 128 | 113 |
| Jev requests | 0 | 114 |
| Recorded Astra cost | $4.760983 | $2.9083605 |
| Recorded Jev cost | $0 | $0.043819776 |
| **Total estimated consumption** | **$4.760983** | **$2.952180276** |
| All spending / resolved issue | $0.595123 | $0.369023 |
| Summed agent time | 1,041.39 s | 636.94 s |
| Input served as cache reads | **91.07%** | **87.39%** |
| Runs with unknown usage | 0 | 1 |

All failed cases and router usage are included. Total recorded model consumption for this experiment: **$7.713163276**. Summed agent time fell **38.84%**; this excludes setup/evaluation time and is not the elapsed duration of the concurrent batch.

### Per-instance outcomes

| Instance | Plain Pi cost | JevCoder cost | Pi / Jev solved |
| --- | ---: | ---: | --- |
| astropy__astropy-13398 | $1.87945 | $0.68530* | No / No |
| django__django-11964 | $0.17040 | $0.16386 | Yes / Yes |
| django__django-13590 | $0.20870 | $0.16150 | Yes / Yes |
| django__django-13925 | $0.21713 | $0.24212 | Yes / Yes |
| django__django-14539 | $0.26526 | $0.17902 | Yes / Yes |
| matplotlib__matplotlib-26342 | $0.35668 | $0.18869 | Yes / Yes |
| pydata__xarray-6992 | $0.27152 | $0.24406 | No / No |
| pytest-dev__pytest-5809 | $0.16019 | $0.14317 | Yes / Yes |
| sphinx-doc__sphinx-10673 | $0.97010 | $0.70826 | Yes / Yes |
| sympy__sympy-16450 | $0.26156 | $0.23621 | Yes / Yes |

JevCoder was cheaper on 9/10 cases. The asterisk denotes unknown usage: the Astropy hybrid stopped after a **Jev HTTP 400**, which returned no usage. Pi then emitted a synthetic zero-usage abort message without an additional Astra request. The accounting deliberately flags this rather than interpreting unreported usage as free. The partial patch was graded, with no rerun or replacement.

## Interpretation and limits

- **Cache reuse improved substantially:** hybrid cache reads were 87.39% of input here, versus 1.56% in the prior filtered-schema batch. All requests within each hybrid run retained one tool/system-prefix fingerprint.
- Fresh plain Pi saw 1,638,943 cache-read tokens and 160,236 cache-write tokens. The hybrid saw 818,508 cache-read tokens and 117,725 cache-write tokens. Output tokens were 22,305 versus 12,298; reasoning is included in output and was not counted twice.
- The primary result is **38% lower recorded-usage spending at equal observed solve count**, not a 50% reduction or a billing receipt. The unknown router request prevents claiming exact total billing.
- Savings are not uniform. Roughly two-thirds of the total dollar difference comes from the unresolved Astropy case, where the hybrid ended early after the router error. As a secondary sensitivity check, spending on the **eight mutually resolved cases alone** was $2.610009 versus $2.022825814, about **22.50% lower**. This does not replace the primary all-ten total.
- This is one generation per arm on the same known development sample used previously. It is not an unseen test set, statistical proof, or a clean attribution of every difference solely to caching. Fresh baselines, alternating order, and fixed source hashes improve comparability but do not eliminate model/service variability or independently reset server caches.
- The prior batch remains preserved ($5.14 vs $8.44); its baseline must not be substituted for this run's $4.76 baseline to inflate the saving.

Machine-readable results, prices, unknown-usage flags, and official per-test grading are in [results.json](results.json). All 20 generated patches are under [patches/](patches/). All experiment/evaluation containers were removed; cached images and prior experiment artifacts were retained.

## Prospective protocol

- Reuse the **exact dataset snapshot** from `verified-10-20260917`, verified by SHA-256. Same ten instance IDs, base commits, issue prompts, and alternating arm order; no replacements or outcome-based filtering.
- Both arms are regenerated from fresh Pi sessions and clean Docker containers. This is a repeat on a known development sample, not a newly held-out sample.
- Copilot `gpt-6-astra`, medium thinking, and Pi 0.85.1 for both arms. Router pinned to `jev-1.13.0`.
- Native `read`, `bash`, `edit`, and `write` implementations with preserved prompt metadata, delegated to separate network-disabled containers; no host credentials, Docker socket, or evaluator artifacts mounted in workers.
- 4 CPUs, 6 GB per worker; two pairs concurrently, sequential arms within a pair, same alternating order as before.
- Per arm: 40 requests, 900 seconds, $5 soft observed-LLM-cost cap checked between requests. No full-run paid retries. Provider-internal/native Pi retries remain recorded when observable.
- JevCoder now preserves the full tool schema list and retains routing controls at their original message boundaries. Its execution gate still admits only the selected action. Compaction/configuration/prefix changes stop a hybrid run; no hidden routing fallback.
- Shell bundling remains permitted in both modes. Router context/timeout limits are unchanged.
- All generation precedes official SWE-bench 4.1.0 evaluation. No agent receives gold/test patches, grading test lists, previous patches, or evaluator feedback.
- Primary comparison: **this batch's** total estimated spending (all ten cases, failures included, plus Jev), solve rate, and spending per resolved issue. Prior results are historical context, not the denominator.
- Missing usage remains unknown, not free. Prices are snapshotted; costs are published-rate consumption estimates, not billing receipts. Provider cache state is not independently controlled.

Frozen settings, source hashes, dataset hashes, and selected cases are in [manifest.json](manifest.json). Exact implementation snapshots and all raw/private artifacts are under `.jevcoder/bench/verified-10-cache-v1-20260917/` (Git-ignored).

## Commands

```powershell
$env:BENCH_BATCH_ID = "verified-10-cache-v1-20260917"
$env:BENCH_SOURCE_BATCH = "verified-10-20260917"
python scripts/bench/progress.py
```

After generation/evaluation, `python scripts/bench/batch.py report` regenerates summaries from saved artifacts without model calls. Existing arm directories are never silently replayed. The source manifest's SHA-256 guards prevent mixing different implementations within a batch.
