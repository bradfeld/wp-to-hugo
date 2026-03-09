import { pathToFileURL } from "node:url";

import {
  loadConfig,
  type ResolvedConfig,
  type VerificationTarget,
} from "./config";
import {
  classifySitemapUrlCandidates,
  collectRouteKeys,
  extractSitemapLocs,
  resolveVerificationMatches,
  type VerificationKeySets,
  type VerificationMatch,
} from "./verification-targets";

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

interface AmbiguityReport {
  url: string;
  candidates: VerificationMatch[];
}

export interface VerificationResult {
  perfect: boolean;
  targets: Record<VerificationTarget, TargetReport>;
  ambiguities: AmbiguityReport[];
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

function emptyWordPressMatches(): VerificationKeySets {
  return {
    posts: new Set<string>(),
    pages: new Set<string>(),
    categories: new Set<string>(),
  };
}

async function fetchAllSitemapUrls(
  config: ResolvedConfig,
  fetchImpl: typeof fetch,
  logger: Logger,
): Promise<string[]> {
  const mainUrl = `${config.siteUrl}/sitemap.xml`;
  logger.log(`  Fetching ${mainUrl}...`);
  const mainXml = await fetchSitemapXml(fetchImpl, mainUrl);

  if (!mainXml.includes("<sitemapindex")) {
    return extractSitemapLocs(mainXml);
  }

  const allUrls: string[] = [];
  const childUrls = extractSitemapLocs(mainXml);
  logger.log(`  Found sitemap index with ${childUrls.length} child sitemaps`);

  for (const childUrl of childUrls) {
    try {
      const childXml = await fetchSitemapXml(fetchImpl, childUrl);
      const childEntries = extractSitemapLocs(childXml);
      allUrls.push(...childEntries);
      logger.log(`  ${childUrl.split("/").pop() || childUrl}: ${childEntries.length} URLs`);
      await delay(DELAY_MS);
    } catch (error) {
      logger.error(`  ✗ ${childUrl}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return allUrls;
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

function renderPublicUrl(config: ResolvedConfig, target: VerificationTarget, key: string): string {
  if (target === "categories") {
    const categoryBase = config.verification.categoryBasePath.replace(/^\/+|\/+$/g, "");
    return `${config.siteUrl}/${categoryBase}/${key}/`;
  }

  return `${config.siteUrl}/${key}/`;
}

function printTargetReport(
  config: ResolvedConfig,
  target: VerificationTarget,
  report: TargetReport,
  logger: Logger,
): void {
  const total = report.wordpress.size;
  const matchRate = total > 0 ? ((report.matched / total) * 100).toFixed(2) : "0.00";

  logger.log(`\n=== ${target} ===`);
  logger.log(`WordPress: ${report.wordpress.size}`);
  logger.log(`Hugo:      ${report.hugo.size}`);
  logger.log(`Matched:   ${report.matched}`);
  logger.log(`Missing:   ${report.missing.length}`);
  logger.log(`Extra:     ${report.extra.length}`);
  logger.log(`Match rate:${matchRate}%`);

  if (report.missing.length > 0) {
    logger.log("Missing URLs:");
    for (const key of report.missing) {
      logger.log(`  ${renderPublicUrl(config, target, key)}`);
    }
  }
}

function printAmbiguities(ambiguities: AmbiguityReport[], logger: Logger): void {
  if (ambiguities.length === 0) {
    return;
  }

  logger.log("\n=== Ambiguities ===");
  for (const ambiguity of ambiguities) {
    const targets = ambiguity.candidates.map((candidate) => `${candidate.target}:${candidate.key}`).join(", ");
    logger.log(`  ${ambiguity.url} -> ${targets}`);
  }
}

function addWordPressMatch(match: VerificationMatch, wordpressMatches: VerificationKeySets): void {
  wordpressMatches[match.target].add(match.key);
}

function classifyAgainstDiscovered(
  urls: string[],
  config: ResolvedConfig,
  discovered: VerificationKeySets,
): { wordpressMatches: VerificationKeySets; ambiguities: AmbiguityReport[] } {
  const wordpressMatches = emptyWordPressMatches();
  const ambiguities: AmbiguityReport[] = [];

  for (const url of urls) {
    const candidates = classifySitemapUrlCandidates(url, config);
    if (candidates.length === 0) {
      continue;
    }

    if (candidates.length === 1) {
      addWordPressMatch(candidates[0], wordpressMatches);
      continue;
    }

    const resolved = resolveVerificationMatches(candidates, discovered);
    if (resolved.length === 1) {
      addWordPressMatch(resolved[0], wordpressMatches);
      continue;
    }

    ambiguities.push({
      url,
      candidates: resolved.length > 0 ? resolved : candidates,
    });
  }

  return { wordpressMatches, ambiguities };
}

export async function runVerification(
  config: ResolvedConfig,
  options: VerificationOptions = {},
): Promise<VerificationResult> {
  const fetchImpl = options.fetch || fetch;
  const logger = options.logger || console;

  logger.log("=== WordPress ↔ Hugo Verification ===\n");
  logger.log("Phase 1: Fetching WordPress sitemaps...");
  const sitemapUrls = await fetchAllSitemapUrls(config, fetchImpl, logger);
  logger.log(`  Total sitemap URLs: ${sitemapUrls.length}\n`);

  logger.log("Phase 2: Discovering Hugo routes...");
  const discovered = collectRouteKeys(config);
  logger.log(`  Posts: ${discovered.posts.size}`);
  logger.log(`  Pages: ${discovered.pages.size}`);
  logger.log(`  Categories: ${discovered.categories.size}`);

  const { wordpressMatches, ambiguities } = classifyAgainstDiscovered(sitemapUrls, config, discovered);
  const targets = {
    posts: buildTargetReport(wordpressMatches.posts, discovered.posts),
    pages: buildTargetReport(wordpressMatches.pages, discovered.pages),
    categories: buildTargetReport(wordpressMatches.categories, discovered.categories),
  };

  for (const target of config.verification.targets) {
    printTargetReport(config, target, targets[target], logger);
  }
  printAmbiguities(ambiguities, logger);

  const perfect =
    ambiguities.length === 0 &&
    config.verification.targets.every((target) => targets[target].missing.length === 0);

  return {
    perfect,
    targets,
    ambiguities,
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
