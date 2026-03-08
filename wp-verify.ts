// wp-verify.ts
// Verify WordPress sitemap against Hugo content
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";

const config = loadConfig();

const CONTENT_DIR = config.contentDir;
const ARCHIVES_DIR = path.join(CONTENT_DIR, "archives");
const DELAY_MS = 100;
const SITEMAP_BASE = config.siteUrl;

// --- Utilities ---

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Sitemap Fetching ---

async function fetchSitemapXml(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  return res.text();
}

// --- URL Extraction ---

function extractArchiveUrls(xml: string): string[] {
  const locRegex = /<loc>(.*?)<\/loc>/g;
  const urls: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = locRegex.exec(xml)) !== null) {
    const url = match[1];
    // Only keep /archives/ URLs (skip pages, custom post types, etc.)
    if (/\/archives\/\d{4}\/\d{2}\//.test(url)) {
      urls.push(url);
    }
  }
  return urls;
}

// --- URL Normalization ---

function urlToKey(url: string): string {
  // Strip protocol and domain
  let urlPath = url
    .replace(new RegExp(`^https?://(?:www\\.)?${config.domainRegex}`), "")
    .replace(/\/$/, ""); // strip trailing slash

  // Extract YYYY/MM/slug from /archives/YYYY/MM/slug
  const match = urlPath.match(/\/archives\/(\d{4}\/\d{2}\/.+)$/);
  if (!match) return "";

  return decodeURIComponent(match[1]).toLowerCase();
}

// --- Fetch All WordPress URLs ---

async function fetchAllWordPressUrls(): Promise<Set<string>> {
  const keys = new Set<string>();

  // Fetch the main sitemap (could be a sitemap index or a regular sitemap)
  const mainUrl = `${SITEMAP_BASE}/sitemap.xml`;
  console.log(`  Fetching ${mainUrl}...`);

  try {
    const mainXml = await fetchSitemapXml(mainUrl);

    if (mainXml.includes("<sitemapindex")) {
      // It's a sitemap index — extract child sitemap URLs
      const locRegex = /<loc>(.*?)<\/loc>/g;
      const childUrls: string[] = [];
      let match: RegExpExecArray | null;
      while ((match = locRegex.exec(mainXml)) !== null) {
        childUrls.push(match[1]);
      }
      console.log(`  Found sitemap index with ${childUrls.length} child sitemaps`);

      for (const childUrl of childUrls) {
        try {
          const childXml = await fetchSitemapXml(childUrl);
          const urls = extractArchiveUrls(childXml);
          let added = 0;
          for (const u of urls) {
            const key = urlToKey(u);
            if (key) { keys.add(key); added++; }
          }
          const filename = childUrl.split("/").pop() || childUrl;
          console.log(`  ${filename}: ${added} archive URLs`);
          await delay(DELAY_MS);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`  ✗ ${childUrl}: ${msg}`);
        }
      }
    } else {
      // It's a regular sitemap — extract URLs directly
      const urls = extractArchiveUrls(mainXml);
      for (const u of urls) {
        const key = urlToKey(u);
        if (key) keys.add(key);
      }
      console.log(`  Found ${keys.size} archive URLs in sitemap`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ Failed to fetch sitemap: ${msg}`);
  }

  return keys;
}

// --- Hugo Content Walking ---

function walkHugoArchives(): string[] {
  const files: string[] = [];

  function walk(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name === "index.md") {
        files.push(fullPath);
      }
      // Skip _index.md (section indexes)
    }
  }

  walk(ARCHIVES_DIR);
  return files;
}

function hugoPathToKey(filePath: string): string {
  // filePath: .../content/archives/YYYY/MM/slug/index.md
  // key: YYYY/MM/slug
  const rel = path.relative(ARCHIVES_DIR, filePath);
  // rel = YYYY/MM/slug/index.md → strip /index.md
  const key = rel.replace(/\/index\.md$/, "").toLowerCase();
  // Decode percent-encoded directory names (e.g., %e2%80%99 → ')
  try {
    return decodeURIComponent(key);
  } catch {
    return key; // If decoding fails, use as-is
  }
}

function buildHugoKeySet(): Set<string> {
  const files = walkHugoArchives();
  const keys = new Set<string>();
  for (const file of files) {
    const key = hugoPathToKey(file);
    if (key) keys.add(key);
  }
  return keys;
}

// --- Comparison & Report ---

function compareAndReport(
  wpKeys: Set<string>,
  hugoKeys: Set<string>,
): boolean {
  const missing: string[] = []; // in WP but not Hugo
  const extra: string[] = []; // in Hugo but not WP
  let matched = 0;

  for (const key of wpKeys) {
    if (hugoKeys.has(key)) {
      matched++;
    } else {
      missing.push(key);
    }
  }

  for (const key of hugoKeys) {
    if (!wpKeys.has(key)) {
      extra.push(key);
    }
  }

  missing.sort();
  extra.sort();

  const total = wpKeys.size;
  const matchRate =
    total > 0 ? ((matched / total) * 100).toFixed(2) : "0.00";

  console.log("\n=== Verification Report ===");
  console.log(`WordPress posts: ${wpKeys.size}`);
  console.log(`Hugo posts:      ${hugoKeys.size}`);
  console.log(`Matched:         ${matched}`);
  console.log(`Missing (WP→Hugo): ${missing.length}`);
  console.log(`Extra (Hugo only):  ${extra.length}`);
  console.log(`Match rate:      ${matchRate}%`);

  if (missing.length > 0) {
    console.log("\n=== Missing Posts (in WordPress but not Hugo) ===");
    for (const key of missing) {
      console.log(`  ${config.siteUrl}/archives/${key}/`);
    }
  }

  if (extra.length > 0) {
    console.log("\n=== Extra Posts (in Hugo but not WordPress) ===");
    for (const key of extra) {
      console.log(`  content/archives/${key}/index.md`);
    }
  }

  const perfect = missing.length === 0;
  if (perfect) {
    console.log("\n✓ All WordPress posts have corresponding Hugo content!");
  } else {
    console.log(
      `\n✗ ${missing.length} WordPress post(s) missing from Hugo content.`,
    );
  }

  return perfect;
}

// --- Main ---

async function main(): Promise<void> {
  console.log("=== WordPress ↔ Hugo Verification ===\n");

  // Phase 1: Fetch WordPress sitemap URLs
  console.log("Phase 1: Fetching WordPress sitemaps...");
  const wpKeys = await fetchAllWordPressUrls();
  console.log(`  Total unique archive URLs: ${wpKeys.size}\n`);

  // Phase 2: Walk Hugo content
  console.log("Phase 2: Walking Hugo archives...");
  const hugoKeys = buildHugoKeySet();
  console.log(`  Total Hugo archive posts: ${hugoKeys.size}`);

  // Phase 3: Compare
  const perfect = compareAndReport(wpKeys, hugoKeys);

  process.exit(perfect ? 0 : 1);
}

main().catch(console.error);
