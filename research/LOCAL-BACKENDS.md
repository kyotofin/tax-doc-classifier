# Local backends: can a model on our own server replace Jev?

## Summary

- **Yes. Ship the `rules` backend first.** It uses no model. It has 0 wrong pages and 0 strict errors on the held-out TaxCalcBench pages, which is the same result as Jev. It takes about 3 ms per page.
- **Add `decider-4b` behind the rules for the pages that the rules cannot decide.** On the blank IRS corpus, rules + decider-4b have 30 strict errors (4.01%). Jev has 38 (5.05%). No page is wrong at a confidence of 0.95 or more. A page that goes to the model takes about 22 s of CPU time.
- **Do not use GLiNER2.5.** Zero-shot, it is wrong on 31% (blank) and 48% (bench) of pages, and it almost never reaches the gate.
- Use gate **0.95**. Below the gate, **fail closed**: send the page to a person, and never to an outside model.
- No page text leaves the machine in any of these backends.

## What we measured

All numbers come from `pnpm eval` runs on one machine. The result files are in `eval/results/`.

- Machine: Apple M1 Pro, 8 cores (6 performance), 16 GB RAM, arm64, macOS. CPU only. No backend used the GPU or Metal.
- Text extraction: `pdftotext -layout`, the same for every backend (`src/state.ts`).
- Strict score: a page is an error if the form is wrong or if the confidence is below 0.95.
- Latency: the wall time of `classifyPage` for one page, with concurrency 1. The first 5 pages are excluded (warm-up). The time for text extraction is not included.
- Jev numbers come from the README. We did not call Jev or any other remote model.

### Main results

| Backend | Corpus | Pages | Wrong | Strict errors | Confident-wrong ≥0.95 | p50 | p95 | Model memory (peak RSS) | Model load |
|---|---|---|---|---|---|---|---|---|---|
| **Jev (README)** | bench | 314 | 0 | 0 (0.00%) | 0 | ~0.5 s | – | remote | – |
| **Jev (README)** | blank | 753 | 0 | 38 (5.05%) | 0 | ~0.5 s | – | remote | – |
| **rules** | bench | 314 | 0 | **0 (0.00%)** | 0 | 2.9 ms | 3.9 ms | none (Node 116 MB) | – |
| **rules** | blank | 748 | 17 | 50 (6.68%) | 0 | 3.5 ms | 6.1 ms | none (Node 152 MB) | – |
| **rules + decider-4b** (hybrid, lean) | blank | 748 | 11 | **30 (4.01%)** | 0 | 3.9 ms | 20.9 s | 3.5 GB | 12 s |
| rules + decider-4b | bench | 314 | 0 | 0 (0.00%) | 0 | 2.9 ms | 3.9 ms | – | – |
| decider-4b only (rules top-10 shortlist, lean), every 5th page | bench | 63 | 1 | 4 (6.35%) | 0 | 14.4 s | 22.9 s | 4.8 GB | 12 s |
| rules + decider-2b (hybrid, lean) | blank | 748 | 20 | 47 (6.28%) | 0 | 3.7 ms | 7.4 s | 2.5 GB | 15 s |
| rules + decider-2b (hybrid, full descriptions) | blank | 748 | 25 | 49 (6.55%) | 0 | 3.8 ms | 17.3 s | 2.5 GB | 15 s |
| rules + GLiNER2.5-base (hybrid) | blank | 748 | 37 | 49 (6.55%) | 0 | 3.5 ms | 0.6 s | 2.7 GB | 7 s |
| rules + GLiNER2.5-base (hybrid) | bench | 314 | 0 | 0 (0.00%) | 0 | 2.9 ms | 3.9 ms | 2.7 GB | 7 s |
| GLiNER2.5-base | blank | 748 | 234 | 730 (97.59%) | 1 | 1.38 s | 1.88 s | 2.7 GB | 7 s |
| GLiNER2.5-base | bench | 314 | 151 | 258 (82.17%) | 0 | 0.60 s | 2.11 s | 2.7 GB | 7 s |
| GLiNER2.5-small | blank | 748 | 617 | 741 (99.06%) | 0 | 0.51 s | 1.52 s | 2.0 GB | 5 s |
| GLiNER2.5-small | bench | 314 | 144 | 314 (100.00%) | 0 | 0.56 s | 1.15 s | 2.0 GB | 5 s |

Notes on the table:

- The hybrid rows show latency over all pages. Rules decide most pages in a few milliseconds. On the blank corpus, 50 of 748 pages go to the model. The time for those pages alone:

  | Model on the 50 pages that rules abstain on | Right form | Right and ≥ 0.95 | Wrong and ≥ 0.95 | p50 | p95 |
  |---|---|---|---|---|---|
  | GLiNER2.5-base | 13 | 1 | 0 | 1.4 s | 2.3 s |
  | decider-2b, full descriptions | 25 | 1 | 0 | 19.0 s | 24.6 s |
  | decider-2b, lean | 30 | 3 | 0 | 8.3 s | 10.1 s |
  | **decider-4b, lean** | **39** | **20** | **0** | **21.9 s** | **24.8 s** |

- On the bench, rules decide every page. For this reason, each hybrid bench row is the same as the rules row, and no bench page goes to the model.
- decider-4b used 3,938 CPU-seconds for 50 blank pages (about 79 per page) and 3,908 CPU-seconds for 63 bench pages (about 62 per page), on 6 threads.
- The decider-4b bench row is a sample: every 5th bench page (`--sample=5`). A full run was stopped after 8 pages, because the machine was swapping (14.6 GB of 15 GB swap in use by other applications). This made each page take about 3 minutes. We restarted the model server and ran the sample. The swap was still high during the sample run and the blank decider runs, so the decider times can be higher than on an idle machine.
- On the bench sample, decider-4b alone is right on 62 of 63 pages. Its only uncertain pages are 1099-B pages, where Form 8949 is the runner-up. The wrong page (1099-B read as 8949) has a confidence of 0.50. This shows that decider-4b alone is weaker than the rules on filled forms. It is useful only behind the rules.
- "Model memory" is the peak RSS of the local model process. The Node process is shown separately where no model runs.

### Calibration

Coverage is the share of pages at or above the gate. Accuracy is measured on those pages only.

| Backend | Corpus | Gate 0.80 | Gate 0.90 | Gate 0.95 | Gate 0.99 |
|---|---|---|---|---|---|
| rules | bench | 100% / 100% | 100% / 100% | 100% / 100% | 100% / 100% |
| rules | blank | 94.0% / 100% | 93.7% / 100% | 93.3% / 100% | 92.0% / 100% |
| rules + decider-4b | blank | 98.1% / 99.46% (4 wrong) | 97.1% / 99.86% (1 wrong) | 96.0% / 100% | 93.2% / 100% |
| rules + decider-2b lean | blank | 95.7% / 99.72% (2 wrong) | 94.7% / 100% | 93.7% / 100% | 92.0% / 100% |
| rules + GLiNER-base | blank | 93.9% / 99.72% (2 wrong) | 93.6% / 99.86% (1 wrong) | 93.4% / 100% | 92.0% / 100% |
| GLiNER-base | blank | 12.7% / 92.63% (7 wrong) | 5.1% / 94.74% (2 wrong) | 2.5% / 94.74% (1 wrong) | 0.9% / 100% |
| GLiNER-base | bench | 21.0% / 100% | 17.8% / 100% | 17.8% / 100% | 16.9% / 100% |

Each cell shows coverage / accuracy. The rules confidence is conservative: no rules page is wrong at any gate. With decider-4b, gate 0.90 lets 1 wrong page through, and gate 0.95 lets none through.

### Page kinds

- Blank pages: every backend labels all 7 labelled blank pages as `blank`.
- Bench: all 314 pages are filled form pages. Jev's result file labels all of them `form_page`. The rules label all 314 as `form_page`. GLiNER-base labels 57 as `state_tax_form` and 50 as `instructions`.
- The hybrid backends take the page kind from the rules.
- No other kind labels exist in either corpus. For this reason, we did not measure `instructions`, `cover_sheet` and the other kinds.

## The backends

All backends implement the existing `Backend.ask(state, questions)` interface. `classify.ts` is not changed.

- `src/backends/rules.ts`: deterministic scoring, generated from `data/criteria.json`. The patterns are the printed label (`Form 1099-INT`, `Schedule A (Form 1040)`), the footer with a year or revision (`Form 8582-CR (Rev. 12-2024)`), the split schedule header (`SCHEDULE A` above `(Form 8978)`), the "developments related to Form X" sentence, the `irs.gov/FormX` address, title words, and box labels. The scores go through a softmax (temperature 1). A `not_in_this_list` score of 5 takes the probability when no form clearly wins. The result is that a page with no self-identification abstains.
- `src/backends/gliner.ts` + `service/gliner_server.py`: GLiNER2.5 in a local Python HTTP service on 127.0.0.1. It uses a two-step hierarchy: first the family (W-2, 1099, 1098, 1040, other information return, other form), then the form in that family. When a family has more than 40 forms, the labels go through a tournament in groups of 40, and the top 3 of each group go to a final round. We chose a Python service over ONNX for two reasons. The GLiNER2.5 "boundary" architecture has no ONNX export that we could use. The Python package is also the reference implementation.
- `src/backends/decider.ts` + `service/decider_server.py`: [Mapika/decider](https://huggingface.co/Mapika/decider-2b) (Apache-2.0). It is an open model of the same kind as Jev: it reads the state and the options and returns a probability for each option in one forward pass. It accepts Jev's request shape, so `deciderBackend` is `jevBackend` pointed at 127.0.0.1. It runs the Q4_K_M GGUF files on llama.cpp, on the CPU only. Before it sends the page, the backend collapses runs of spaces and dot leaders. "Lean" sends only the name and title of each option. It does not send the box examples or the `not_for` lists.
- `src/backends/shortlist.ts`: asks the model about the rules' top 10 forms only. The page kind comes from the rules. On the 50 pages that rules abstain on (blank corpus), the right form is in the rules' top 1 on 33, in the top 10 on 46, and in the top 40 on all 50.
- `src/backends/hybrid.ts`: rules first. The model is called only when the rules confidence is below the gate.

Select a backend with `pnpm eval --backend=rules|gliner|hybrid|decider|hybrid-decider`. The other flags are `--gliner-url`, `--decider-url`, `--shortlist=10`, `--lean=1` and `--tag`.

## Error analysis

### Rules (blank corpus: 50 strict errors, 17 wrong, none at ≥ 0.95)

| Cause | Strict errors | Wrong | Highest confidence on a wrong page |
|---|---|---|---|
| Instruction pages of information returns that do not name their own form, such as "Instructions for Recipient (continued)" on 1099-x, 1098-x, 5498-x, W-2 and 2439 | 36 | 9 | 0.38 |
| W-2AS, W-2GU, W-2VI and W-2c pages that are almost the same in each form | 8 | 4 | 0.38 |
| Form 1042-S code tables and bilingual pages that mention Form 1040-NR but not 1042-S in a place that the rules read (the manifest lists 1042-S twice, so each page counts twice) | 6 | 4 | 0.004 |

Many instruction pages name only the forms that the recipient must file, such as Schedule D, Form 8949 or Form 1040. The rules give those mentions few points, so the page abstains and does not guess with high confidence.

### Rules + decider-4b (blank: 30 strict errors, 11 wrong, none at ≥ 0.95)

decider-4b resolves 20 of the 50 pages that rules abstain on, at 0.95 or more. These are mostly instruction pages of 1098-C, 1098-F, 1099-DIV, 2439 and W-2.

| Cause | Strict errors | Wrong | Highest confidence on a wrong page |
|---|---|---|---|
| Instruction pages that do not name their own form | 18 | 4 | 0.87 |
| W-2 variants that share pages | 6 | 3 | 0.93 |
| Form 1042-S code tables and bilingual pages (counted twice) | 6 | 4 | 0.87 |

The wrong pages pick a form that the page discusses. Examples: 1099-B p7 → Form 8949, 1099-S p4 → Schedule D, W-2AS/W-2VI p7 → Form 8889 (the page is about HSA amounts), 1042-S → Form 1040-NR. Sibling forms are also confused: 1099-LS → 1099-SB, and W-2GU p5 → W-2c at 0.93, just below the gate.

### GLiNER2.5

- **The family step fails.** Many 1099 and 1040 pages go to the "other form" family. Inside that family, a few labels win on many unrelated pages: Form 8995-A, 8949 and 1095-A.
- **Exact identifiers are not meanings.** GLiNER matches meaning. The page type depends on one exact string, for example `1099-INT` or `1099-OID`, and `8995` or `8995-A`. These labels have almost the same meaning to the model.
- **The confidence does not help.** At temperature 1, almost no page reaches 0.95. At temperature 0.3, 15 of 190 test pages were wrong at ≥ 0.95. We kept temperature 1.
- Titles as label descriptions made the result worse (96 wrong of 190 against 78) and slower (p50 3.4 s).

## Changes made after looking at the bench (held-out) results

We report these changes because the bench is the held-out set.

1. **GLiNER family labels.** The first bench run had 253 wrong and 303 strict errors. It showed that the family labels were opaque codes (`w2`, `f1099`), which is a defect in the backend. We replaced them with readable names and checked the change on the blank corpus first (78 → 58 wrong on a quarter sample). After the fix, the bench has 151 wrong and 258 strict errors. Both runs appear above.
2. We did not change the rules, the decider settings or the shortlist after we looked at any bench result. We chose the rules, the temperature (1) and the `not_in_this_list` score (5) on the blank corpus only. The decider choices (lean descriptions, kind from the rules, top-10 shortlist, 4B over 2B) come from the blank corpus runs only.

## Recommendation

1. **Ship `rulesBackend` now.** Its accuracy on filled forms matches Jev on the bench. It needs no model, no Python and no network. It runs in about 3 ms per page on one core.
2. **Gate at 0.95.** At 0.95 no backend in the recommended path has a confidently wrong page on either corpus. Do not lower the gate for the hybrid with decider-4b: at 0.90 it lets 1 wrong page through.
3. **Below the gate, fail closed.** Put the page in a review queue for a person, or ask the user which form it is. Never send it to an outside model. The redaction step must not run on a page whose form is not known.
4. **Add decider-4b as a second step later, if the abstention rate on real uploads is high.** It removes 20 of the 50 abstentions on the blank corpus, with no confident errors. Most of those abstentions are instruction pages. For real uploads, instruction pages can often be dropped instead of classified.
5. **Keep the decider in the same container as the app, or in a private service.** It listens on 127.0.0.1 only. The page text stays on our machine.

### Cost on a CPU-only host (Railway has no GPU)

- **rules:** no extra memory beyond Node (about 100–150 MB for the whole process), and about 3 ms of one core per page. The cost is almost zero.
- **decider-4b (Q4_K_M, llama.cpp):** 2.7 GB of weights and 3.5–4.8 GB peak RSS. It needs about 60–80 CPU-seconds per model page on the M1 Pro performance cores. On the blank corpus, 50 of 748 pages (6.7%) went to the model. On the bench, 0 pages went to the model.
- Railway prices and x86 speed are **UNVERIFIED**. Use: monthly cost ≈ (reserved RAM in GB × the price per GB-month) + (model pages per month × CPU-seconds per page ÷ 2,592,000 × the price per vCPU-month). We expect x86 server cores to be slower than M1 performance cores per thread. Measure it on the target host before you size it.
- A service that must hold 3.5 GB of RAM all the time costs more than the CPU time at low volume. You can start the decider only when a page abstains, but the load time (about 12 s) then adds to that page.

## What we could not measure

- **Speed on the target host.** All times are from an Apple M1 Pro. Railway x86 speed is UNVERIFIED.
- **Jev on our machine.** The Jev numbers come from the README (753 blank pages). Our blank corpus has 748 pages, because the IRS revised Forms 5713, 5713 Schedule A, 8609-A and 8873 after the manifest was written, and those PDFs now have fewer pages. `eval/run.ts` now uses the smaller of the manifest count and the real page count.
- **Page kinds other than `blank` and `form_page`.** Neither corpus labels them.
- **Real uploads.** Both corpora are clean IRS PDFs or bench renders. Scans, OCR text, broker consolidated statements and state forms are not tested. The `rules` result can be worse on OCR text with errors in the form number.
- **A general local LLM that scores options by log-probability** (for example Qwen2.5-7B-Instruct). We tested decider in its place. decider is a Qwen3.5 model trained for exactly this output. A general 7B model on CPU would be slower than decider-4b.
- **Kev** (`jaredpalmer/kev-*`), the other open Jev-like model. It was not tested.
- **decider on PyTorch CPU.** One run with the full 231-option list and decider-2b took 350–400 s per page (about 25k tokens, reference kernels). We did not continue with that path.
- **decider-4b on every bench page.** We ran it on every 5th page only (63 of 314), for the reason given under the results table. We did not run decider-2b alone on the bench.

## Setup

All models, virtual environments and downloads were in one scratch folder outside the repo: `~/Workspace/kyoto/tdc-local-scratch`. We deleted it after the study. The commands below rebuild it.

```
uv venv -p 3.12 venv && source venv/bin/activate
uv pip install "gliner2[local]" "transformers>=5"
python service/gliner_server.py --model fastino/gliner2.5-base-v1 --port 8765

uv venv -p 3.12 venv-decider && source venv-decider/bin/activate
CMAKE_ARGS="-DGGML_METAL=off" uv pip install "decider-ai[gguf]"
python service/decider_server.py --model <folder with decider-4b-GGUF files> --gguf-file decider-4b-v2.1-Q4_K_M.gguf --port 8771

pnpm eval --backend=rules --corpus=blank
pnpm eval --backend=hybrid-decider --corpus=blank --lean=1 --decider-url=http://127.0.0.1:8771 --tag=4b-lean
```

Model versions: `fastino/gliner2.5-base-v1`, `fastino/gliner2.5-small-v1` (gliner2 2.0.0, transformers 5.17.0, torch 2.14.0); `Mapika/decider-2b-GGUF` `decider-2b-v11-Q4_K_M.gguf` and `Mapika/decider-4b-GGUF` `decider-4b-v2.1-Q4_K_M.gguf` (decider-ai 1.6.0, llama-cpp-python 0.3.35, CPU build).
