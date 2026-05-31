import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'static',
  site: 'https://sunwjy.github.io',
  vite: {
    plugins: [tailwindcss()],
  },
});
