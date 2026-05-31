# sunwjy.github.io

Static GitHub Pages website built with Astro, Tailwind CSS, Biome, and pnpm.

The resume is published under `/resume/`.

## Commands

```sh
pnpm install
pnpm dev
pnpm build
pnpm preview
pnpm lint
pnpm format
pnpm check
```

## GitHub Pages

The deploy workflow builds `dist/` and publishes it to GitHub Pages for the
`sunwjy.github.io` user site. Astro is configured with
`site: 'https://sunwjy.github.io'`, so no repository `base` path is used.
