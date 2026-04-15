import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { viteCommonjs } from '@originjs/vite-plugin-commonjs'

export default defineConfig({
  main: {
    build: {
      outDir: 'dist/main'
    }
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].js'
        }
      }
    }
  },
  renderer: {
    assetsInclude: ['**/*.wasm'],
    plugins: [react(), viteCommonjs()],
    optimizeDeps: {
      exclude: ['@cornerstonejs/dicom-image-loader'],
      include: [
        'dicom-parser',
        'jpeg-lossless-decoder-js/release/lossless.js',
        'jpeg-lossless-decoder-js/release/lossless-min.js',
        'jpeg-lossless-decoder-js/release/cjs/lossless.cjs'
      ]
    },
    worker: {
      format: 'es'
    },
    build: {
      outDir: 'dist/renderer'
    }
  }
})