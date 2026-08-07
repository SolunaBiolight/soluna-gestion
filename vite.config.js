import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // Librerías estables en chunks propios: sus hashes no cambian entre
        // deploys, así el navegador las cachea y cada release solo obliga a
        // re-descargar el código de la app (antes: 2,2MB en cada deploy).
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('firebase')) return 'firebase';
          if (id.includes('react')) return 'react';
        },
      },
    },
  },
})
