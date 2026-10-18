import { builtinModules } from 'node:module'
import { defineConfig } from 'vite'

export default defineConfig({
  ssr: {
    noExternal: true
  },
  build: {
    ssr: 'src/server/index.ts',
    outDir: 'dist/server',
    target: 'node22',
    sourcemap: true,
    rollupOptions: {
      external: [...builtinModules],
      output: {
        format: 'cjs',
        entryFileNames: 'index.cjs',
        inlineDynamicImports: true
      }
    }
  }
})
