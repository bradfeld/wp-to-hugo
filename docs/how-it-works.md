# How It Works

This document explains the migration pipeline in detail — how each script works, the design decisions behind them, and what to watch for.

## The Migration Pipeline

The migration runs in 5 phases, each handled by a separate script. Run them in order:

1. **Content Export** (`wp-export.ts`) — Posts, pages, taxonomies
2. **Custom Post Types** (`export-custom-types.ts`) — Books, films, or whatever your site has
3. **Media Download** (`wp-media-download.ts`) — Images downloaded and URLs rewritten
4. **Entity Cleanup** (`fix-entities.ts`) — HTML entities decoded in frontmatter
5. **Verification** (`wp-verify.ts`) — Compare against WordPress sitemap

Each phase is idempotent. You can re-run any script safely — it either picks up where it left off or skips already-processed items.

---

## Phase 1: Content Export

**Script:** `wp-export.ts`

### How the WP REST API works

WordPress exposes a paginated REST API at `/wp-json/wp/v2/`. The export script fetches:

1. **Categories** (`/wp-json/wp/v2/categories`) — all category terms with IDs and names
2. **Tags** (`/wp-json/wp/v2/tags`) — all tag terms with IDs and names
3. **Posts** (`/wp-json/wp/v2/posts`) — all blog posts, 100 per page
4. **Pages** (`/wp-json/wp/v2/pages`) — static pages (About, Contact, etc.)

Pagination uses the `X-WP-Total` and `X-WP-TotalPages` response headers. The script fetches pages sequentially with a configurable delay between requests to avoid rate limiting.

### Taxonomy mapping

WordPress stores categories and tags as numeric IDs on each post. The script first loads all categories and tags into lookup maps (`id → name`), then uses these to generate frontmatter arrays.

### HTML-to-Markdown conversion

Post content comes as HTML from WordPress. The [Turndown](https://github.com/mixmark-io/turndown) library handles the conversion with custom rules for:

- **WordPress block comments** (`<!-- wp:paragraph -->`) — stripped entirely
- **Empty paragraphs** (`<p></p>`) — removed
- **Caption shortcodes** (`[caption]...[/caption]`) — extracted to plain image markdown
- **ATX-style headings** (`# Heading` instead of underline style)
- **Fenced code blocks** (triple backticks)

### Frontmatter generation

Each post gets Hugo frontmatter with:

```yaml
---
title: "Post Title"
date: 2024-03-15T10:00:00
slug: "post-slug"
categories: ["Category One", "Category Two"]
tags: ["tag1", "tag2"]
description: "First 200 characters of the excerpt..."
draft: false
---
```

HTML entities in titles and descriptions are decoded during export. The description is derived from the WordPress excerpt (HTML stripped, first 200 characters).

### Page bundle output

Posts are written as Hugo page bundles:

```
content/archives/YYYY/MM/slug/index.md
```

This preserves the WordPress URL structure. With the right permalink config in `hugo.toml`, every old URL continues to work without redirects.

That archive layout is now the default, not a hardcoded requirement. `postRoute.contentPath` controls where post bundles are written, and `postRoute.urlPath` controls the matching WordPress route pattern used for verification. When `postRoute` is omitted, the exporter and verifier still use the legacy archive behavior.

Supported route tokens:

- `:slug`
- `:id`
- `:year`
- `:month`
- `:day`

Examples:

```json
{
  "postRoute": {
    "contentPath": "posts/:slug",
    "urlPath": "/:slug/"
  }
}
```

```json
{
  "postRoute": {
    "contentPath": "posts/:year/:month/:day/:slug",
    "urlPath": "/:year/:month/:day/:slug/"
  }
}
```

Static pages go to the content root: `content/about.md`, `content/contact.md`, etc.

### Resumable state

The script saves progress to `.export-state.json` after each page of API results. If it crashes or gets rate-limited, re-running picks up at the last successful page. The state tracks:

- Current phase (taxonomies, posts, custom types, pages)
- Number of posts exported
- Last successfully fetched page number
- Which custom types have been exported

---

## Phase 2: Custom Post Types

**Script:** `export-custom-types.ts`

WordPress custom post types (books, films, portfolios, events, etc.) live at separate API endpoints. This script reads the `customPostTypes` array from `wp-config.json` and exports each one.

Each custom post type endpoint works the same as the posts endpoint — paginated JSON with the same response structure. Items are written to their own content directories:

```
content/books/my-book-title/index.md
content/films/some-film/index.md
```

To find your site's custom post type endpoints, visit `https://yoursite.com/wp-json/wp/v2/` — it lists all available REST API routes including custom types.

Not all custom post types are exposed via the REST API. They must be registered with `show_in_rest = true` in WordPress.

---

## Phase 3: Media Download

**Script:** `wp-media-download.ts`

This is the most complex phase. WordPress serves images through several URL patterns, and the script handles all of them.

### WordPress CDN URL variants

WordPress (especially WordPress.com-hosted or Jetpack-enabled sites) serves images through the Photon CDN. A single image might appear as:

- `https://i0.wp.com/yoursite.com/wp-content/uploads/2024/01/photo.jpg?w=800`
- `https://i2.wp.com/www.yoursite.com/wp-content/uploads/2024/01/photo.jpg`
- `https://yoursite.com/wp-content/uploads/2024/01/photo.jpg`
- `https://www.yoursite.com/wp-content/uploads/2024/01/photo.jpg?resize=300,200`

The script normalizes all variants by:
1. Stripping query parameters (`?w=800`, `?resize=300,200`)
2. Removing CDN prefix (`i0.wp.com/`)
3. Removing `www.` prefix
4. Extracting the upload path (`2024/01/photo.jpg`)

### Reference counting

Before downloading, the script scans ALL markdown files and counts how many posts reference each unique image. This determines where each image goes:

- **Single-use images** (referenced by 1 post) → co-located in that post's page bundle directory, referenced as `./photo.jpg`
- **Shared images** (referenced by 2+ posts) → stored in `static/images/` with a year-month prefix to avoid collisions (e.g., `2024-01-photo.jpg`), referenced as `/images/2024-01-photo.jpg`

This is important for Hugo page bundles. Co-located images are cleaner and travel with the post, but shared images can't live in two page bundles simultaneously.

### Download strategy

1. **Idempotent**: If a file already exists with non-zero size, it's skipped
2. **CDN-first**: Downloads from `i0.wp.com` first (more reliable, serves optimized images)
3. **Fallback**: If CDN returns an error, tries the direct site URL
4. **Rate-limited**: 100ms delay between downloads

### URL rewriting

After downloading, the script rewrites every WordPress media URL in the markdown files to point to the local path. All variants of the same image URL (with different query parameters) get rewritten to the same local path.

### Dry run

Run with `--dry-run` to see what would be downloaded without actually downloading or modifying files:

```bash
npx tsx wp-media-download.ts --dry-run
```

---

## Phase 4: Entity Cleanup

**Script:** `fix-entities.ts`

WordPress stores HTML entities in post titles and descriptions. Common ones:

| Entity | Character | Example |
|--------|-----------|---------|
| `&amp;` | & | "Tom & Jerry" |
| `&#8217;` | ' | "It's" |
| `&#8220;` `&#8221;` | " " | "quoted text" |
| `&hellip;` | … | "Wait…" |
| `&ndash;` | – | "2020–2024" |
| `&mdash;` | — | "word — word" |

The export script does an initial decode, but some entities survive in edge cases (nested encoding, entities in excerpts). This cleanup pass:

1. Walks all content files
2. Extracts the YAML frontmatter
3. Decodes all named, numeric, and hex HTML entities
4. Re-escapes the YAML strings (decoded characters like `"` need proper YAML escaping)
5. Writes back only if changes were made

---

## Phase 5: Verification

**Script:** `wp-verify.ts`

The final step compares your WordPress sitemap against the Hugo content directory.

### Sitemap auto-discovery

The script fetches `/sitemap.xml` from your WordPress site. If it's a sitemap index (contains `<sitemapindex>`), it automatically discovers and fetches all child sitemaps. This handles sites with multiple sitemap files without any configuration.

### Comparison logic

For each URL in the WordPress sitemap:
1. Extract the path and validate it against `postRoute.urlPath`
2. Normalize the rendered route path to a verification key
3. Check for a matching Hugo file by projecting `content/*/index.md` paths through `postRoute.contentPath`

The script reports:
- **Match rate** (percentage of WordPress URLs found in Hugo)
- **Missing posts** (in WordPress but not in Hugo)
- **Extra posts** (in Hugo but not in WordPress — usually fine, could be drafts you published after export)

### Multi-target verification

Verification now supports:

- posts
- pages
- categories
- authors

The default config remains backward compatible:

```json
{
  "verification": {
    "targets": ["posts"],
    "sources": ["content"],
    "publicDir": "./public",
    "categoryBasePath": "/category/",
    "authorBasePath": "/author/"
  }
}
```

When you expand `verification.targets`, the verifier classifies sitemap URLs into one or more target candidates, discovers Hugo route keys from the configured sources, and then resolves overlaps against what Hugo actually owns.

Discovery sources:

- `content`: scans route-owning markdown files such as `content/about.md` and `content/categories/essays/_index.md`
- `public`: scans built output such as `public/about/index.html`, `public/category/essays/index.html`, and `public/author/jane-doe/index.html`

If you enable both, the discovered route keys are unioned before comparison.

### Overlapping route spaces

Some sites use overlapping route spaces, especially slug-only posts and root-level pages. In that case the verifier keeps multiple candidates for a sitemap URL and resolves them against the discovered Hugo outputs instead of assuming a target up front.

If more than one candidate remains plausible after discovery, the verifier reports that URL in a separate ambiguity section instead of silently counting it as matched or missing.

### Author export

Author export is optional and off by default. When enabled, the exporter fetches `/wp-json/wp/v2/users`, builds an `id -> slug` map, and appends the configured front matter field to posts when a matching user exists.

It can also write a stable JSON data file for Hugo usage, using the configured `authorExport.dataFile` path. The file contents are sorted by slug so reruns remain deterministic.

If `/users` is unavailable, export continues successfully with a warning and skips author enrichment for that run. If a post references an author ID that is missing from an otherwise successful users response, the exporter omits the field and warns once per missing ID.

### Content transforms

Every markdown-writing export path now runs through one shared writer:

- posts from `wp-export.ts`
- pages from `wp-export.ts`
- custom post types exported inside `wp-export.ts`
- custom post types exported by `export-custom-types.ts`

The writer pipeline is:

1. Convert HTML to Markdown
2. Apply the optional transform from `contentTransform`
3. Write the final markdown file

`contentTransform.module` is resolved relative to `wp-config.json`. By default the loader calls the module's `default` export, but you can override that with `contentTransform.exportName`.

The transform receives `(markdown, context)` where `context.kind` is `post`, `page`, or `custom-post-type`, and `context.slug` identifies the item being written. This makes it safe to target specific cleanup rules without forking the exporter.

If the configured export is not a function, or the transform throws, export fails with a descriptive error that includes the content kind and slug.

### What "100%" means

A 100% match rate means every URL in the WordPress sitemap has a corresponding Hugo content file. This is the target before switching DNS.

---

## URL Preservation

The most important aspect of a WordPress-to-Hugo migration is preserving URLs. Every inbound link, bookmark, and search engine result should continue to work.

The default WordPress route in this project is:
```
https://yoursite.com/archives/2024/03/my-post-slug/
```

The default Hugo page bundle mirrors that exactly:
```
content/archives/2024/03/my-post-slug/index.md
```

With the permalink configuration:
```toml
[permalinks.page]
  archives = "/archives/:year/:month/:slug/"
```

Hugo generates the same URLs. No redirects needed.

Other permalink shapes are now configured in `wp-config.json` instead of patching the scripts. If you use a different `postRoute`, your Hugo permalink configuration needs to emit the same public URLs.

---

## State Files

Both `wp-export.ts` and `wp-media-download.ts` create state files for resumability:

| File | Script | Contents |
|------|--------|----------|
| `.export-state.json` | `wp-export.ts` | Current phase, pages fetched, posts exported |
| `.media-download-state.json` | `wp-media-download.ts` | Processed files list, failed download URLs |

These are gitignored. Delete them to start fresh:

```bash
rm -f .export-state.json .media-download-state.json
```
