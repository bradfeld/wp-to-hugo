# wp-to-hugo

Migrate a WordPress blog to Hugo with URL preservation. Exports posts, pages, custom post types, and media — then verifies completeness against the WordPress sitemap.

Built for migrating [feld.com](https://feld.com) (5,530 posts, 22 years) from WordPress to Hugo using [Claude Code](https://claude.ai/code). The scripts are generic and work with any WordPress site that has the REST API enabled.

## Prerequisites

- **[Node.js](https://nodejs.org/) 20+** — runs the migration scripts
- **A WordPress site with the REST API enabled** — test by visiting `https://yoursite.com/wp-json/wp/v2/posts` (should return JSON)
- **[Hugo](https://gohugo.io/)** — the static site generator that builds your new site (see [quick start](https://gohugo.io/getting-started/quick-start/))
- **[Git](https://git-scm.com/) and a [GitHub](https://github.com/) account** — to store your Hugo site in a repo
- **A hosting platform** — [Vercel](https://vercel.com/), [Netlify](https://www.netlify.com/), or [GitHub Pages](https://pages.github.com/) to serve the built site

The scripts handle content migration (export, media, verification). Setting up Hugo, choosing a theme, and configuring deployment is separate — Hugo's quick start guide covers most of it.

## Quick Start

```bash
# Clone the repo
git clone https://github.com/bradfeld/wp-to-hugo.git
cd wp-to-hugo

# Install dependencies
npm install

# Configure your site
cp wp-config.example.json wp-config.json
# Edit wp-config.json with your site URL and custom post types

# Run the migration (in order)
npm run export              # Phase 1: Export posts and pages
npm run export-custom       # Phase 2: Export custom post types
npm run media               # Phase 3: Download images and rewrite URLs
npm run fix-entities        # Phase 4: Clean up HTML entities in frontmatter
npm run verify              # Phase 5: Verify against WordPress sitemap
```

## Scripts

| Script | Command | What it does |
|--------|---------|-------------|
| `wp-export.ts` | `npm run export` | Fetches all posts and pages via WP REST API, converts HTML to Markdown, writes Hugo page bundles |
| `export-custom-types.ts` | `npm run export-custom` | Exports custom post types (books, films, etc.) to separate content directories |
| `wp-media-download.ts` | `npm run media` | Scans exported markdown for WordPress media URLs, downloads images, rewrites URLs to local paths |
| `fix-entities.ts` | `npm run fix-entities` | Decodes HTML entities (`&amp;`, `&#8217;`, etc.) in frontmatter titles and descriptions |
| `wp-verify.ts` | `npm run verify` | Fetches WordPress sitemap(s) and compares configured post, page, and category routes against Hugo content and/or built output |

## Configuration

Edit `wp-config.json` (copy from `wp-config.example.json`):

```json
{
  "siteUrl": "https://yoursite.com",
  "contentDir": "./content",
  "postRoute": {
    "contentPath": "archives/:year/:month/:slug",
    "urlPath": "/archives/:year/:month/:slug/"
  },
  "verification": {
    "targets": ["posts"],
    "sources": ["content"],
    "publicDir": "./public",
    "categoryBasePath": "/category/"
  },
  "customPostTypes": [
    { "type": "book", "section": "books" },
    { "type": "portfolio", "section": "portfolio" }
  ]
}
```

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `siteUrl` | Yes | — | Your WordPress site URL (no trailing slash) |
| `contentDir` | No | `./content` | Where to write Hugo content files (relative to `wp-config.json`) |
| `postRoute.contentPath` | No | `archives/:year/:month/:slug` | Hugo bundle path pattern for exported posts |
| `postRoute.urlPath` | No | `/archives/:year/:month/:slug/` | WordPress URL pattern used for verification and URL planning |
| `verification.targets` | No | `["posts"]` | Which targets to verify from the sitemap |
| `verification.sources` | No | `["content"]` | Where to discover Hugo routes: `content`, `public`, or both |
| `verification.publicDir` | No | `./public` | Built Hugo output directory, resolved relative to `wp-config.json` |
| `verification.categoryBasePath` | No | `/category/` | Base path used for category archive URLs |
| `customPostTypes` | No | `[]` | WordPress custom post type endpoints and their Hugo content directories |

### Post Routes

Post export and verification share the same route config. If you omit `postRoute`, the original archive behavior stays unchanged:

- post bundles are written to `content/archives/YYYY/MM/slug/index.md`
- verification matches `/archives/YYYY/MM/slug/`

Supported route tokens are:

- `:slug`
- `:id`
- `:year`
- `:month`
- `:day`

Example slug-only route:

```json
{
  "postRoute": {
    "contentPath": "posts/:slug",
    "urlPath": "/:slug/"
  }
}
```

Example day-dated route:

```json
{
  "postRoute": {
    "contentPath": "posts/:year/:month/:day/:slug",
    "urlPath": "/:year/:month/:day/:slug/"
  }
}
```

Hugo still needs matching permalink rules for whichever `urlPath` you choose. The exporter only controls where content is written and how verification normalizes WordPress URLs.

### Verification Targets

If you omit `verification`, the original behavior stays in place:

- only posts are verified
- discovery comes from `content/`
- pages and categories are ignored

Available targets:

- `"posts"`
- `"pages"`
- `"categories"`

Available discovery sources:

- `"content"` scans route-owning markdown files
- `"public"` scans generated `index.html` files in your Hugo build output

You can use either source independently or both together. When both are enabled, the verifier unions discovered routes across both trees.

Example multi-target configuration:

```json
{
  "verification": {
    "targets": ["posts", "pages", "categories"],
    "sources": ["content", "public"],
    "publicDir": "./public",
    "categoryBasePath": "/category/"
  }
}
```

For category verification from content, the expected route-owning file is `content/categories/<slug>/_index.md`. For public discovery, the expected built path is `public/category/<slug>/index.html`.

### Custom Post Types

Each entry maps a WordPress REST API endpoint to a Hugo content section:

- `type`: The WP REST API endpoint name (e.g., `book`, `film`, `tribe_events`)
- `section`: The Hugo content directory name (e.g., `books`, `films`, `events`)

To find your custom post type endpoints, visit `https://yoursite.com/wp-json/wp/v2/` — it lists all available endpoints.

## Hugo Setup

The scripts output content in Hugo's [page bundle](https://gohugo.io/content-management/page-bundles/) format:

```
content/
├── archives/
│   └── 2024/
│       └── 03/
│           └── my-post-slug/
│               ├── index.md          # Post content
│               └── featured-image.jpg # Co-located image
├── books/
│   └── my-book/
│       └── index.md
└── about.md                          # Static page
```

To preserve WordPress URLs, add this to your `hugo.toml`:

```toml
[permalinks.page]
  archives = "/archives/:year/:month/:slug/"
```

This maps `content/archives/2024/03/my-post/index.md` to `/archives/2024/03/my-post/` — the same URL structure WordPress uses.

If you change `postRoute`, update your Hugo permalinks to match that URL pattern. The default archive route is only the fallback.

## How It Works

See [docs/how-it-works.md](docs/how-it-works.md) for a detailed walkthrough of the migration pipeline, including:

- How the WP REST API pagination works
- HTML-to-Markdown conversion (Turndown, block comments, shortcodes)
- Media reference counting (co-located vs. shared images)
- Resumable state files for large sites
- Sitemap auto-discovery for verification

## Resumable Exports

All export scripts save progress to state files (`.export-state.json`, `.media-download-state.json`). If a script crashes or gets rate-limited, re-run it and it picks up where it left off.

To start fresh, delete the state files:

```bash
rm -f .export-state.json .media-download-state.json
```

## Dry Run (Media)

Preview what the media download will do without downloading anything:

```bash
npx tsx wp-media-download.ts --dry-run
```

## Troubleshooting

### WP REST API returns 403 or is disabled

Some WordPress hosts disable the REST API. Check:
- Visit `https://yoursite.com/wp-json/wp/v2/posts` in a browser
- If blocked, you may need a plugin like [WP REST API Controller](https://wordpress.org/plugins/flavor-developer/) or ask your host

### Rate limiting

If you get HTTP 429 errors, the scripts have a built-in 100ms delay between requests. For aggressive rate limiting, increase `DELAY_MS` in the script.

### Missing custom post types

Custom post types must be registered with `show_in_rest = true` in WordPress. If a type doesn't appear at `/wp-json/wp/v2/`, it's not exposed to the REST API. You may need a plugin or code change in WordPress to expose it.

### HTML entities in titles

Run `npm run fix-entities` after the initial export. WordPress stores HTML entities like `&amp;`, `&#8217;` (smart quotes), and `&hellip;` in post titles and descriptions. The fix-entities script decodes these to proper characters and re-escapes YAML strings.

### Sitemap verification shows missing posts

Some WordPress plugins generate incomplete sitemaps. The verify script checks `/sitemap.xml` and auto-discovers child sitemaps. If your sitemap uses a non-standard path, you may need to adjust the `SITEMAP_BASE` in `wp-verify.ts`.

## Origin

These scripts were built for migrating [feld.com](https://feld.com) — 5,530 blog posts spanning 22 years — from WordPress to Hugo. The migration was done entirely with [Claude Code](https://claude.ai/code). Read the full story: [Migrating Feld Thoughts from WordPress to Hugo](https://feld.com/archives/2026/03/migrating-feld-thoughts-from-wordpress-to-hugo/).

## License

MIT
