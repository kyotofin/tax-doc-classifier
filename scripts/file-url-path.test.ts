import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { fileUrlPath } from './file-url-path.js'

it('resolves file URLs to native paths for eval and generator scripts', () => {
  const repoRoot = process.cwd()
  const evalUrl = pathToFileURL(resolve(repoRoot, 'eval', 'run.ts')).href
  const generatorUrl = pathToFileURL(resolve(repoRoot, 'scripts', 'build-criteria.ts')).href

  expect(resolve(fileUrlPath(evalUrl))).toBe(resolve(repoRoot, 'eval'))
  expect(resolve(fileUrlPath(generatorUrl, '..'))).toBe(repoRoot)
})
