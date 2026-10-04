import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const common = { bundle: true, sourcemap: true, logLevel: 'info', minify: !watch };

const host = {
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
};

const webview = {
  ...common,
  entryPoints: ['webview/issue.ts'],
  outdir: 'dist/webview',
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
};

if (watch) {
  const ctxs = await Promise.all([esbuild.context(host), esbuild.context(webview)]);
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('watching…');
} else {
  await Promise.all([esbuild.build(host), esbuild.build(webview)]);
}
