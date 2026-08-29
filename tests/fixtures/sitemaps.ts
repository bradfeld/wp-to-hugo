export function makeSitemap(urls: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset>${urls
    .map((url) => `<url><loc>${url}</loc></url>`)
    .join("")}</urlset>`;
}
