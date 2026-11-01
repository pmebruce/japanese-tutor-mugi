import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
export default defineConfig({
  plugins: [react()],
  define: { 'import.meta.env.VITE_CLOUD_MODE': JSON.stringify('1') },
  build: { rolldownOptions: { output: { manualChunks(id: string) { return id.includes('soundtouchjs') ? 'soundtouch' : undefined; } } } },
});
