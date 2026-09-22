import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json' with { type: 'json' };

export default defineConfig({
  plugins: [vue(), crx({ manifest })],
  server: { port: 5174, strictPort: true },
  build: { target: 'chrome120' },
});
