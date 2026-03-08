// wp-media-download.ts
// Phase 2b: Download WordPress media and co-locate with Hugo page bundles
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";

const config = loadConfig();

const CONTENT_DIR = config.contentDir;
const STATIC_IMAGES_DIR = config.staticImagesDir;
const STATE_FILE = path.resolve(process.cwd(), ".media-download-state.json");
const DELAY_MS = 100;
const DRY_RUN = process.argv.includes("--dry-run");

// --- Types ---

interface DownloadState {
  processedFiles: string[];
  failedUrls: { url: string; file: string; error: string }[];
}

interface NormalizedUrl {
  downloadUrl: string;
  filename: string;
  uploadPath: string; // e.g., "2019/01/image.jpg" — dedup key
}

interface Stats {
  totalFiles: number;
  filesWithMedia: number;
  totalImages: number;
  sharedImages: number;
  downloaded: number;
  skipped: number;
  failed: number;
  rewritten: number;
}

// --- Utilities ---

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- URL Detection ---

// Matches WP media URLs for the configured site:
//   https://i0.wp.com/{domain}/wp-content/uploads/...
//   https://i0.wp.com/www.{domain}/wp-content/uploads/...
//   https://{domain}/wp-content/uploads/...
//   https://www.{domain}/wp-content/uploads/...
// Captures the full URL including query params

function findMediaUrls(markdown: string): string[] {
  const regex = new RegExp(config.mediaUrlRegex.source, config.mediaUrlRegex.flags);
  const matches = markdown.match(regex);
  if (!matches) return [];
  // Deduplicate within the same file
  return [...new Set(matches)];
}

// --- URL Normalization ---

function normalizeUrl(url: string): NormalizedUrl {
  // Strip query params
  const withoutParams = url.split("?")[0];

  // Normalize to direct site URL
  // Handle: i0.wp.com/{domain}/..., i0.wp.com/www.{domain}/..., www.{domain}/...
  const normalized = withoutParams
    .replace(new RegExp(`^https?://i\\d\\.wp\\.com/(?:www\\.)?${config.domainRegex}`), `https://${config.domain}`)
    .replace(new RegExp(`^https?://www\\.${config.domainRegex}`), `https://${config.domain}`);

  // Extract the upload path after /wp-content/uploads/
  const uploadPathMatch = normalized.match(
    /\/wp-content\/uploads\/(.+)$/,
  );
  const uploadPath = uploadPathMatch ? uploadPathMatch[1] : "";
  const filename = path.basename(uploadPath);

  // Build download URL: prefer CDN (more reliable)
  const cdnPath = normalized.replace(`https://${config.domain}`, "");
  const downloadUrl = `https://i0.wp.com/${config.domain}${cdnPath}`;

  return { downloadUrl, filename, uploadPath };
}

// --- Content File Discovery ---

function findContentFiles(): string[] {
  const files: string[] = [];

  function walk(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith(".md")) {
        files.push(fullPath);
      }
    }
  }

  walk(CONTENT_DIR);
  return files;
}

// --- Reference Counting (Shared Image Detection) ---

function buildReferenceMap(
  files: string[],
): Map<string, Set<string>> {
  const refMap = new Map<string, Set<string>>(); // uploadPath -> set of file paths

  for (const file of files) {
    const content = fs.readFileSync(file, "utf-8");
    const urls = findMediaUrls(content);
    for (const url of urls) {
      const { uploadPath } = normalizeUrl(url);
      if (!uploadPath) continue;
      if (!refMap.has(uploadPath)) {
        refMap.set(uploadPath, new Set());
      }
      refMap.get(uploadPath)!.add(file);
    }
  }

  return refMap;
}

// --- Destination Resolver ---

function isPageBundle(filePath: string): boolean {
  return path.basename(filePath) === "index.md";
}

function resolveDestination(
  filePath: string,
  uploadPath: string,
  filename: string,
  isShared: boolean,
): { diskPath: string; markdownUrl: string } {
  if (isShared || !isPageBundle(filePath)) {
    // Shared images or non-page-bundle files → static/images/
    // Prefix with upload year-month to avoid collisions
    const parts = uploadPath.split("/");
    let prefixedFilename = filename;
    if (parts.length >= 3) {
      // uploadPath is like "2019/01/image.jpg"
      prefixedFilename = `${parts[0]}-${parts[1]}-${filename}`;
    }
    return {
      diskPath: path.join(STATIC_IMAGES_DIR, prefixedFilename),
      markdownUrl: `/images/${prefixedFilename}`,
    };
  }

  // Page bundle: co-locate with the post
  const postDir = path.dirname(filePath);
  return {
    diskPath: path.join(postDir, filename),
    markdownUrl: `./${filename}`,
  };
}

// --- Image Download ---

async function downloadImage(
  url: string,
  destPath: string,
): Promise<"downloaded" | "skipped" | "failed"> {
  // Idempotency: skip if file already exists with non-zero size
  if (fs.existsSync(destPath)) {
    const stat = fs.statSync(destPath);
    if (stat.size > 0) {
      return "skipped";
    }
  }

  if (DRY_RUN) {
    return "downloaded"; // Pretend success in dry-run
  }

  try {
    const res = await fetch(url);
    if (!res.ok) {
      // Try fallback: direct site URL
      const directUrl = url.replace(
        new RegExp(`^https?://i\\d\\.wp\\.com/${config.domainRegex}`),
        `https://${config.domain}`,
      );
      if (directUrl !== url) {
        const fallbackRes = await fetch(directUrl);
        if (!fallbackRes.ok) {
          console.error(`  ✗ ${res.status} ${url} (fallback also ${fallbackRes.status})`);
          return "failed";
        }
        const buffer = Buffer.from(await fallbackRes.arrayBuffer());
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, buffer);
        return "downloaded";
      }
      console.error(`  ✗ ${res.status} ${url}`);
      return "failed";
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buffer);
    return "downloaded";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ Download error: ${msg} — ${url}`);
    return "failed";
  }
}

// --- URL Rewrite ---

function rewriteFileUrls(
  filePath: string,
  urlMap: Map<string, string>,
): boolean {
  if (DRY_RUN) return true;

  let content = fs.readFileSync(filePath, "utf-8");
  let changed = false;

  for (const [originalUrl, localPath] of urlMap) {
    if (content.includes(originalUrl)) {
      content = content.split(originalUrl).join(localPath);
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(filePath, content);
  }
  return changed;
}

// --- Checkpoint ---

function loadState(): DownloadState {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  }
  return { processedFiles: [], failedUrls: [] };
}

function saveState(state: DownloadState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// --- Per-File Processing ---

async function processFile(
  filePath: string,
  refMap: Map<string, Set<string>>,
  state: DownloadState,
  stats: Stats,
): Promise<void> {
  // Skip already-processed files
  if (state.processedFiles.includes(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const urls = findMediaUrls(content);
  if (urls.length === 0) return;

  stats.filesWithMedia++;
  const urlMap = new Map<string, string>(); // originalUrl -> local markdown URL

  for (const originalUrl of urls) {
    const { downloadUrl, filename, uploadPath } = normalizeUrl(originalUrl);
    if (!uploadPath || !filename) {
      console.warn(`  ⚠ Could not parse: ${originalUrl}`);
      continue;
    }

    stats.totalImages++;

    const refCount = refMap.get(uploadPath)?.size ?? 1;
    const isShared = refCount >= 2;
    if (isShared) stats.sharedImages++;

    const { diskPath, markdownUrl } = resolveDestination(
      filePath,
      uploadPath,
      filename,
      isShared,
    );

    if (DRY_RUN) {
      const relFile = path.relative(CONTENT_DIR, filePath);
      console.log(
        `  ${isShared ? "[shared]" : "[local]"} ${relFile}: ${filename} → ${markdownUrl}`,
      );
      stats.downloaded++;
    } else {
      const result = await downloadImage(downloadUrl, diskPath);
      if (result === "downloaded") {
        stats.downloaded++;
        await delay(DELAY_MS);
      } else if (result === "skipped") {
        stats.skipped++;
      } else {
        stats.failed++;
        state.failedUrls.push({
          url: downloadUrl,
          file: filePath,
          error: "Download failed",
        });
      }
    }

    // Map ALL original URL variants (with query params) to the local path
    urlMap.set(originalUrl, markdownUrl);
  }

  // Rewrite URLs in the markdown file
  if (urlMap.size > 0) {
    const rewrote = rewriteFileUrls(filePath, urlMap);
    if (rewrote) stats.rewritten++;
  }

  state.processedFiles.push(filePath);
  if (!DRY_RUN) {
    saveState(state);
  }
}

// --- Summary ---

function printSummary(stats: Stats, state: DownloadState): void {
  console.log("\n=== Summary ===");
  console.log(`Files scanned:    ${stats.totalFiles}`);
  console.log(`Files with media: ${stats.filesWithMedia}`);
  console.log(`Images found:     ${stats.totalImages}`);
  console.log(`  Shared:         ${stats.sharedImages}`);
  console.log(`  Downloaded:     ${stats.downloaded}`);
  console.log(`  Skipped (exist):${stats.skipped}`);
  console.log(`  Failed:         ${stats.failed}`);
  console.log(`Files rewritten:  ${stats.rewritten}`);

  if (state.failedUrls.length > 0) {
    console.log("\n=== Failed Downloads ===");
    for (const { url, file } of state.failedUrls) {
      const relFile = path.relative(CONTENT_DIR, file);
      console.log(`  ${url}`);
      console.log(`    in: ${relFile}`);
    }
  }
}

// --- Main ---

async function main(): Promise<void> {
  console.log(`=== WordPress Media Download ${DRY_RUN ? "(DRY RUN)" : ""} ===\n`);

  const state = loadState();
  if (state.processedFiles.length > 0) {
    console.log(`Resuming: ${state.processedFiles.length} files already processed\n`);
  }

  // Phase 1: Discover content files
  console.log("Phase 1: Discovering content files...");
  const files = findContentFiles();
  console.log(`  Found ${files.length} markdown files\n`);

  // Phase 2: Build reference map for shared image detection
  console.log("Phase 2: Scanning for media URLs and counting references...");
  const refMap = buildReferenceMap(files);
  const sharedCount = [...refMap.values()].filter((s) => s.size >= 2).length;
  const totalUniqueImages = refMap.size;
  console.log(`  ${totalUniqueImages} unique images across ${files.length} files`);
  console.log(`  ${sharedCount} shared images (referenced by 2+ files)\n`);

  // Phase 3: Process each file
  console.log("Phase 3: Downloading images and rewriting URLs...");
  const stats: Stats = {
    totalFiles: files.length,
    filesWithMedia: 0,
    totalImages: 0,
    sharedImages: 0,
    downloaded: 0,
    skipped: 0,
    failed: 0,
    rewritten: 0,
  };

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (state.processedFiles.includes(file)) continue;

    const relPath = path.relative(CONTENT_DIR, file);
    if (!DRY_RUN && i % 50 === 0) {
      console.log(`  Processing ${i + 1}/${files.length} (${relPath})...`);
    }

    try {
      await processFile(file, refMap, state, stats);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ Error processing ${relPath}: ${msg}`);
      if (!DRY_RUN) saveState(state);
    }
  }

  printSummary(stats, state);

  if (DRY_RUN) {
    console.log("\nDry run complete. No files were modified or downloaded.");
  } else {
    console.log("\nDone!");
  }
}

main().catch(console.error);
