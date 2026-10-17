import { defineConfig } from 'vitest/config'
import ts from 'typescript'
import { resolve } from 'node:path'

const sdkRoot = process.env.DSH_SOURCE_ROOT
const sdkPaths = sdkRoot ? ts.readConfigFile(resolve(sdkRoot, 'tsconfig.base.json'), ts.sys.readFile) : undefined
if (sdkPaths?.error) throw new Error(ts.flattenDiagnosticMessageText(sdkPaths.error.messageText, '\n'))
const alias = Object.entries<string[]>(sdkPaths?.config.compilerOptions.paths ?? {})
  .filter(([name]) => !name.includes('*') && !name.startsWith('@deepseek-ai/dsh-session-link'))
  .sort(([a], [b]) => b.length - a.length)
  .map(([find, candidates]) => ({ find, replacement: resolve(sdkRoot!, candidates[0]!) }))

export default defineConfig({
  resolve: { alias: [{ find: '@deepseek-ai/dsh-client-ui-primitives',
    replacement: resolve(import.meta.dirname, 'tests/fixtures/host-ui-primitives.tsx') }, ...alias] },
  plugins: [{
    name: 'standard-decorators', enforce: 'pre',
    transform(code, id) {
      if (!/\.[cm]?tsx?$/.test(id) || !/^\s*@[A-Za-z_$][\w$]*/m.test(code)) return
      const output = ts.transpileModule(code, { fileName: id, compilerOptions: {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.ReactJSX, sourceMap: true,
      } })
      return { code: output.outputText, map: output.sourceMapText }
    },
  }],
  test: {
    include: ['tests/*.spec.{ts,tsx}'], pool: 'forks',
    execArgv: process.allowedNodeEnvironmentFlags.has('--webstorage') ? ['--no-webstorage'] : [],
    maxWorkers: 2, testTimeout: 15000,
  },
})
