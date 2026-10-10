/** Resolve optional checkout SDK declarations without coupling the runtime to that checkout. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sdkRoot = process.env.DSH_SOURCE_ROOT
const paths = {}
if (sdkRoot) {
  const root = resolve(sdkRoot)
  const result = ts.readConfigFile(resolve(root, 'tsconfig.base.json'), ts.sys.readFile)
  if (result.error) throw new Error(ts.flattenDiagnosticMessageText(result.error.messageText, '\n'))
  for (const [name, candidates] of Object.entries(result.config.compilerOptions.paths)) {
    const declarations = candidates.map(candidate => {
      const source = resolve(root, candidate)
      if (!source.includes('/src')) return undefined
      const base = source.replace('/src', '/lib/types')
      return /\.tsx?$/.test(base) ? base.replace(/\.tsx?$/, '.d.ts') : `${base}/index.d.ts`
    }).filter(candidate => candidate && (candidate.includes('*') || existsSync(candidate)))
    if (declarations.length) paths[name] = declarations
  }
  delete paths['@deepseek-ai/dsh-session-link']
  delete paths['@deepseek-ai/dsh-session-link/types']
}
writeFileSync(resolve(pluginRoot, 'tsconfig.sdk.json'), JSON.stringify({ compilerOptions: { paths } }, null, 2) + '\n')
writeFileSync(resolve(pluginRoot, 'tsconfig.build.json'), JSON.stringify({
  extends: './tsconfig.json', compilerOptions: { paths },
}, null, 2) + '\n')
const manifest = JSON.parse(readFileSync(resolve(pluginRoot, 'package.json'), 'utf8'))
console.log(`SDK: ${sdkRoot ? resolve(sdkRoot) + ' (declarations only)' : 'installed development peers'}; plugin ${manifest.version}`)
