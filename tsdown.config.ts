import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    name: 'dsh-session-link',
    entry: ['lib/types/index.js', 'lib/types/tools.js', 'lib/types/command.js'],
    outDir: 'lib', format: ['esm'], fixedExtension: false,
    platform: 'node', target: 'es2024', dts: false, clean: false, minify: false,
    deps: { neverBundle: [/^@deepseek-ai\//, /^zod($|\/)/] },
  },
  {
    name: 'dsh-session-link/client',
    entry: { client: 'lib/types/client/index.js' },
    outDir: 'lib', format: ['cjs'], platform: 'browser', target: 'es2024',
    dts: false, clean: false,
    deps: { neverBundle: /^react(-dom)?($|\/)/ },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-session-link", factory: (require) => {',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])
