import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileUrlPath } from '../scripts/file-url-path.js'
import {
  classifyPage,
  firstListCriteria,
  isCoverSheet,
  jevBackend,
  pdfPageCount,
  pdfPageLines,
  score,
  summarize,
  type Criteria,
  type Scored,
} from '../src/index.js'

type Row = { id: string; source: string; url: string; pages: number; blankPages: number[] }
type Job = { file: string; truth: string; page: number; pageCount: number; label: string }

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')))
const corpus = args.corpus ?? 'blank'
const gate = Number(args.gate ?? 0.95)
const concurrency = Number(args.concurrency ?? 12)
const root = fileUrlPath(import.meta.url)
const criteria = JSON.parse(await readFile(join(root, '..', 'data', 'criteria.json'), 'utf8')) as Criteria

const BENCH_MAP: Record<string, string> = {
  w2: 'form-w-2',
  w2g: 'form-w-2g',
  '1040': 'form-1040',
  '1099int': 'form-1099-int',
  '1099b': 'form-1099-b',
  '1099div': 'form-1099-div',
  '1099r': 'form-1099-r',
  '1099misc': 'form-1099-misc',
  '1099g': 'form-1099-g',
  '1099nec': 'form-1099-nec',
  '1099k': 'form-1099-k',
  '1099sa': 'form-1099-sa',
  '1098': 'form-1098',
  '1098t': 'form-1098-t',
  '1098e': 'form-1098-e',
}

async function blankJobs(): Promise<Job[]> {
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as Row[]
  const jobs: Job[] = []
  for (const row of manifest) {
    const file = join(root, 'corpus', 'blank', `${row.id}.pdf`)
    for (let p = 1; p <= row.pages; p++) {
      const truth = row.blankPages.includes(p) ? 'blank' : row.id
      jobs.push({ file, truth, page: p, pageCount: row.pages, label: row.id })
    }
  }
  return jobs
}

async function benchJobs(dir: string): Promise<Job[]> {
  const jobs: Job[] = []
  for (const c of await readdir(dir, { withFileTypes: true })) {
    if (!c.isDirectory()) continue
    const input = join(dir, c.name, 'input')
    let files: string[] = []
    try {
      files = (await readdir(input)).filter((f) => f.endsWith('.pdf'))
    } catch {
      continue
    }
    for (const f of files) {
      const stem = basename(f, '.pdf').replace(/_\d+$/, '').replace('_2024', '')
      const truth = BENCH_MAP[stem]
      if (!truth) throw new Error(`no id for bench file ${f}`)
      const file = join(input, f)
      const n = await pdfPageCount(file)
      for (let p = 1; p <= n; p++) jobs.push({ file, truth, page: p, pageCount: n, label: `${c.name}/${f}` })
    }
  }
  return jobs
}

const jobs = corpus === 'bench' ? await benchJobs(args.dir ?? process.env.BENCH_DIR ?? '') : await blankJobs()
const backend = jevBackend()
const firstList = firstListCriteria(criteria)
const t0 = Date.now()
const rows: (Scored & { label: string; page: number; pageCount: number; kind: string })[] = []
let done = 0
const queue = [...jobs]
async function worker() {
  for (;;) {
    const j = queue.shift()
    if (!j) return
    const lines = await pdfPageLines(j.file, j.page)
    if (isCoverSheet(lines)) continue
    const result = await classifyPage(lines, { backend, criteria, gate, firstList })
    rows.push({ ...score(j.truth, result, gate), label: j.label, page: j.page, pageCount: j.pageCount, kind: result.kind })
    if (++done % 100 === 0) console.log(`.. ${done}/${jobs.length} ${Math.round((Date.now() - t0) / 1000)}s`)
  }
}
await Promise.all(Array.from({ length: concurrency }, worker))

const s = summarize(rows)
console.log(`\n${corpus.toUpperCase()}  pages ${s.pages}  time ${Math.round((Date.now() - t0) / 1000)}s  calls ${s.calls}  input_tokens ${s.inputTokens}  cost $${s.estCostUsd.toFixed(3)}`)
console.log(`STRICT (wrong or < ${gate}): ${s.strict} of ${s.pages} = ${(100 * s.strictRate).toFixed(2)}%   wrong ${s.wrong}`)
const strictRows = rows.filter((r) => r.strict).sort((a, b) => a.result.formConfidence - b.result.formConfidence)
for (const r of strictRows)
  console.log(
    `  ${r.label.padEnd(34)} p${r.page}/${String(r.pageCount).padEnd(2)} ${r.truth.padEnd(28)} -> ${r.result.form.padEnd(28)} conf ${r.result.formConfidence.toFixed(2)} kind=${r.kind}${r.wrong ? '  WRONG' : ''}`,
  )
await mkdir(join(root, 'results'), { recursive: true })
const out = join(root, 'results', `${corpus}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`)
await writeFile(out, JSON.stringify({ corpus, gate, summary: s, rows }, null, 1))
console.log(`results → ${out}`)
