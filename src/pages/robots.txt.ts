import type { APIRoute } from 'astro';

const sitemapUrl = new URL('/sitemap-index.xml', import.meta.env.SITE).toString();

export const GET: APIRoute = () => {
  return new Response(`User-agent: *\nAllow: /\n\nSitemap: ${sitemapUrl}\n`, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
};
