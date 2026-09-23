import { fileURLToPath } from 'node:url'

export function fileUrlPath(baseUrl: string, relativeUrl = '.'): string {
  return fileURLToPath(new URL(relativeUrl, baseUrl))
}
