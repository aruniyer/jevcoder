# Cache-stable routing smoke check

JevCoder **0.2.0**, cache mode **`stable-prefix-v1`**. This is a small read-only live check, **not** a rerun or replacement of the ten-instance benchmark.

## Setup

- Model: Copilot `gpt-6-astra`, medium thinking, through Pi 0.85.1.
- Router: `jev-1.13.0`.
- Fresh temporary workspace with three synthetic text files, each containing 80 fixed calibration records and a distinct final marker.
- Only Pi's `read` tool was active. The task requested one read per file and an answer containing all three final markers.
- No context files, skills, or unrelated extensions. JevCoder plus the existing accounting extension were loaded.
- Maximum 6 Jev steps, 180-second process timeout. Actual sequence: `read → read → read → finish`.

## Observed result

All markers were returned correctly, process exit code was 0, and file hashes before/after were identical. The four request-prefix fingerprints were identical, including on `finish`.

| Request | Action | Regular input | Cache read | Cache write | Output | Estimated Astra cost |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | read | 803 | 0 | 0 | 27 | $0.0093800 |
| 2 | read | 3 | 0 | 2,472 | 27 | $0.0322800 |
| 3 | read | 3 | **2,472** | 1,672 | 27 | $0.0247520 |
| 4 | finish | 3 | **4,144** | 1,633 | 51 | $0.0271365 |

- Astra cost from returned usage: **$0.0935485**.
- Jev input: 17,298 tokens, estimated **$0.000726516**.
- Total estimated model consumption: **$0.094275016**.
- Process elapsed time: approximately **16.19 seconds** (includes startup/model/tool work, not a controlled latency comparison).

This confirms that the new append-only control history and unchanged schemas **can reuse provider cache**. It does not quantify the cost change versus the old implementation: there was no matched old-mode arm, and this synthetic task only used `read`. Separate offline regression tests use Pi's actual Responses converters to verify stable schema arrays and append-only inputs through `read → edit → finish` with multiple tools available.

The preceding ten-instance results remain unchanged. A new versioned paired benchmark is still needed to measure task success, caching, and total cost under the revised implementation.

[Returned usage and result](summary.json). Raw event stream and stderr are retained locally under `.jevcoder/cache-smoke-v1/` (Git-ignored).
