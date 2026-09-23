import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { fileUrlPath } from '../scripts/file-url-path.js'

type Row = { id: string; source: string; url: string; pages: number; blankPages: number[] }

const root = fileUrlPath(import.meta.url)
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as Row[]
const dir = join(root, 'corpus', 'blank')
await mkdir(dir, { recursive: true })

let fetched = 0
let skipped = 0
const queue = [...manifest]
async function worker() {
  for (;;) {
    const row = queue.shift()
    if (!row) return
    const out = join(dir, `${row.id}.pdf`)
    try {
      await access(out)
      skipped++
      continue
    } catch {}
    const res = await fetch(row.url, { headers: { 'User-Agent': 'Mozilla/5.0 tax-doc-classifier-eval' } })
    if (!res.ok) throw new Error(`${row.url}: HTTP ${res.status}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (bytes[0] !== 0x25) throw new Error(`${row.url}: not a PDF`)
    await writeFile(out, bytes)
    fetched++
  }
}
await Promise.all(Array.from({ length: 12 }, worker))
console.log(`blank corpus: ${fetched} downloaded, ${skipped} already present, ${manifest.length} forms → ${dir}`)
