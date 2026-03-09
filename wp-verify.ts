import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig, type ResolvedConfig } from "./config";
import { normalizeHugoPostPath, normalizeWordPressPostUrl } from "./routing";

interface Logger {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface VerificationOptions {
  fetch?: typeof fetch;
  logger?: Logger;
}

interface TargetReport {
  wordpress: Set<string>;
  hugo: Set<string>;
  matched: number;
  missing: string[];
  extra: string[];
}

export interface VerificationResult {
  perfect: boolean;
  targets: {
    posts: TargetReport;
  };
}

const DELAY_MS = 100;

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchSitemapXml(fetchImpl: typeof fetch, url: string): Promise<string> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }
  return response.text();
}

function extractLocs(xml: string): string[] {
  const locRegex = /<loc>(.*?)<\/loc>/g;
  const urls: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = locRegex.exec(xml)) !== null) {
    urls.push(match[1]);
  }

  return urls;
}

async function fetchAllWordPressUrls(
  config: ResolvedConfig,
  fetchImpl: typeof fetch,
  logger: Logger,
): Promise<Set<string>> {
  const keys = new Set<string>();
  const mainUrl = `${config.siteUrl}/sitemap.xml`;
  logger.log(`  Fetching ${mainUrl}...`);

  const mainXml = await fetchSitemapXml(fetchImpl, mainUrl);
  if (mainXml.includes("<sitemapindex")) {
    const childUrls = extractLocs(mainXml);
    logger.log(`  Found sitemap index with ${childUrls.length} child sitemaps`);

    for (const childUrl of childUrls) {
      try {
        const childXml = await fetchSitemapXml(fetchImpl, childUrl);
        let added = 0;
        for (const url of extractLocs(childXml)) {
          const key = normalizeWordPressPostUrl(url, config.postRoute.urlPath);
          if (key) {
            keys.add(key);
            added += 1;
          }
        }
        logger.log(`  ${childUrl.split("/").pop() || childUrl}: ${added} matching URLs`);
        await delay(DELAY_MS);
      } catch (error) {
        logger.error(`  ✗ ${childUrl}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return keys;
  }

  for (const url of extractLocs(mainXml)) {
    const key = normalizeWordPressPostUrl(url, config.postRoute.urlPath);
    if (key) {
      keys.add(key);
    }
  }
  logger.log(`  Found ${keys.size} matching URLs in sitemap`);
  return keys;
}

function walkIndexFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const files: string[] = [];

  function walk(currentDir: string): void {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name === "index.md") {
        files.push(fullPath);
      }
    }
  }

  walk(dir);
  return files;
}

function buildHugoKeySet(config: ResolvedConfig): Set<string> {
  const keys = new Set<string>();
  for (const filePath of walkIndexFiles(config.contentDir)) {
    const key = normalizeHugoPostPath(filePath, config.contentDir, config.postRoute);
    if (key) {
      keys.add(key);
    }
  }
  return keys;
}

function buildTargetReport(wordpress: Set<string>, hugo: Set<string>): TargetReport {
  const missing: string[] = [];
  const extra: string[] = [];
  let matched = 0;

  for (const key of wordpress) {
    if (hugo.has(key)) {
      matched += 1;
    } else {
      missing.push(key);
    }
  }

  for (const key of hugo) {
    if (!wordpress.has(key)) {
      extra.push(key);
    }
  }

  missing.sort();
  extra.sort();

  return {
    wordpress,
    hugo,
    matched,
    missing,
    extra,
  };
}

function printReport(config: ResolvedConfig, report: TargetReport, logger: Logger): boolean {
  const total = report.wordpress.size;
  const matchRate = total > 0 ? ((report.matched / total) * 100).toFixed(2) : "0.00";

  logger.log("\n=== Verification Report ===");
  logger.log(`WordPress posts: ${report.wordpress.size}`);
  logger.log(`Hugo posts:      ${report.hugo.size}`);
  logger.log(`Matched:         ${report.matched}`);
  logger.log(`Missing (WP→Hugo): ${report.missing.length}`);
  logger.log(`Extra (Hugo only):  ${report.extra.length}`);
  logger.log(`Match rate:      ${matchRate}%`);

  if (report.missing.length > 0) {
    logger.log("\n=== Missing Posts (in WordPress but not Hugo) ===");
    for (const key of report.missing) {
      logger.log(`  ${config.siteUrl}/${key}/`);
    }
  }

  if (report.extra.length > 0) {
    logger.log("\n=== Extra Posts (in Hugo but not WordPress) ===");
    for (const key of report.extra) {
      logger.log(`  ${key}`);
    }
  }

  if (report.missing.length === 0) {
    logger.log("\n✓ All WordPress posts have corresponding Hugo content!");
    return true;
  }

  logger.log(`\n✗ ${report.missing.length} WordPress post(s) missing from Hugo content.`);
  return false;
}

export async function runVerification(
  config: ResolvedConfig,
  options: VerificationOptions = {},
): Promise<VerificationResult> {
  const fetchImpl = options.fetch || fetch;
  const logger = options.logger || console;

  logger.log("=== WordPress ↔ Hugo Verification ===\n");
  logger.log("Phase 1: Fetching WordPress sitemaps...");
  const wordpressPosts = await fetchAllWordPressUrls(config, fetchImpl, logger);
  logger.log(`  Total unique matching URLs: ${wordpressPosts.size}\n`);

  logger.log("Phase 2: Walking Hugo content...");
  const hugoPosts = buildHugoKeySet(config);
  logger.log(`  Total Hugo posts for configured route: ${hugoPosts.size}`);

  const postsReport = buildTargetReport(wordpressPosts, hugoPosts);
  const perfect = printReport(config, postsReport, logger);

  return {
    perfect,
    targets: {
      posts: postsReport,
    },
  };
}

async function main(): Promise<void> {
  const result = await runVerification(loadConfig());
  process.exit(result.perfect ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
