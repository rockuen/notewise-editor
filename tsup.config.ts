import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/extension.ts'],
    format: ['cjs'],
    platform: 'node',
    target: 'node18',
    outDir: 'dist',
    external: ['vscode'],
    sourcemap: true,
    clean: true,
    dts: false,
  },
  {
    entry: ['src/webview/main.ts'],
    format: ['iife'],
    globalName: 'NoteWiseEditorWebview',
    platform: 'browser',
    target: 'es2020',
    outDir: 'dist',
    sourcemap: true,
    clean: false,
    splitting: false,
    dts: false,
  },
]);
