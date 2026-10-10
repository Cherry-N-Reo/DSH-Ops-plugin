/** Bundle the plugin's browser settings page for DSH's dynamic module loader. */
export default {
  entry: { client: 'lib/client/index.js' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  clean: false,
  sourcemap: true,
  deps: {
    neverBundle: (source: string) => source === 'react' || source === 'react/jsx-runtime',
    alwaysBundle: (source: string) => source !== 'react' && source !== 'react/jsx-runtime',
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-sre-webshell", factory: (require) => {',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
}
