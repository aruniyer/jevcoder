# JevCoder

## What is JevCoder?

JevCoder is an extension of the [Pi coding agent](https://pi.dev) that uses [Jev](https://typesafe.ai) to make tool decisions, while your selected Pi model handles reasoning, tool arguments, and code generation.

For each step:

1. **Jev selects the next action** from the current context: a tool, `code_editing`, or `finish`.
2. **The Pi model fills in the arguments or writes the edit.**
3. **Pi executes the permitted tool**, and the result becomes context for the next decision.

JevCoder reuses Pi's models, authentication, tools, and UI. Tool schemas stay stable and routing decisions are appended to the model context to preserve prompt-cache reuse. An execution gate admits only the action Jev selected.

## Install the extension

With Pi installed:

```bash
pi install git:github.com/aruniyer/jevcoder
```

Restart Pi or use `/reload` after installation.

For installation options and extension details, see Pi's [package documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) and [extension documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md). This extension was tested with Pi **0.85.1**.

## Use in Pi

Set your Jev key in the shell before starting Pi:

```bash
export TYPESAFE_API_KEY="your-typesafe-api-key"
pi
```

Or in PowerShell:

```powershell
$env:TYPESAFE_API_KEY = "your-typesafe-api-key"
pi
```

In Pi, configure your model provider with `/login` if needed and select a model with `/model`. Then run:

```text
/jevcoder <prompt>
```

For example:

```text
/jevcoder Fix the parser's off-by-one error and run the relevant tests
```

Cancel with **Escape** or **`/jevcoder-stop`**. Ordinary prompts continue to use normal Pi execution. JevCoder supports models using OpenAI Chat/Responses or Anthropic Messages APIs.

Textual session context is sent to TypeSafe/Jev as well as your chosen model. Pi's existing tool permissions still apply; JevCoder does not add a sandbox or approval dialogs.

## Results

We evaluated **10 seeded samples from [SWE-bench Verified](https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified)**, comparing two ways of running the same issue prompt:

- **Pi without Jev:** submit `<prompt>` normally.
- **Pi with JevCoder:** submit `/jevcoder <prompt>`.

Both used **GPT-6 Astra**, with **medium** thinking, identical tools and budgets, and fresh sessions and clean repository containers. Execution order alternated across samples. We measured success by grading each generated patch with the **official SWE-bench evaluation harness**, and estimated cost from reported token usage, including Jev's routing cost.

| Metric | Pi without Jev | Pi with JevCoder |
| --- | ---: | ---: |
| Issues resolved | **8/10 (80%)** | **8/10 (80%)** |
| Estimated total cost, including failed cases | **$4.76** | **$2.95** |
| Astra requests | 128 | 113 |

**Both setups resolved the same eight issues, with a 38% lower estimated total cost for JevCoder.**

**Caveat:** The unresolved Astropy case contributed a large share of the saving: its JevCoder run stopped after a Jev HTTP 400, which returned no usage. Excluding only Astropy, the reduction was **21.3%**; across the **eight issues both setups solved**, it was **22.5%**. These are reported-usage estimates on a small, known development sample—not exact bills or a guarantee of savings on other tasks.

See the [experiment report](experiments/verified-10-cache-v1-20260917/README.md) for the protocol, per-instance outcomes, and caveats, or the [results JSON](experiments/verified-10-cache-v1-20260917/results.json) for token counts, pricing, and official grading. Generated patches and frozen benchmark source snapshots are included alongside the results.
