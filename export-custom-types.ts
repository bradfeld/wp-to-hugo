import path from "node:path";
import { pathToFileURL } from "node:url";

import { decodeHtmlEntities, escapeYamlString, writeMarkdownContent } from "./export-content";
import { loadConfig, type ResolvedConfig } from "./config";

interface Logger {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

interface WPPost {
  id: number;
  date: string;
  slug: string;
  title: { rendered: string };
  content: { rendered: string };
  excerpt: { rendered: string };
}

export interface CustomTypeExportOptions {
  fetch?: typeof fetch;
  logger?: Logger;
  writerRecorder?: (callsite: string) => void;
}

export interface CustomTypeExportResult {
  counts: Record<string, number>;
  outputPaths: string[];
}

async function fetchAllPages<T>(
  fetchImpl: typeof fetch,
  wpApiUrl: string,
  endpoint: string,
): Promise<T[]> {
  const all: T[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const url = `${wpApiUrl}/${endpoint}?per_page=100&page=${page}`;
    const response = await fetchImpl(url);
    if (!response.ok) {
      throw new Error(`API error ${response.status}: ${url}`);
    }
    const data = await response.json() as T[];
    all.push(...data);
    totalPages = parseInt(response.headers.get("X-WP-TotalPages") || "0", 10) || 1;
    page += 1;
  } while (page <= totalPages);

  return all;
}

function buildFrontMatter(post: WPPost): string {
  const title = decodeHtmlEntities(post.title.rendered);
  const rawExcerpt = (post.excerpt?.rendered || "")
    .replace(/<[^>]+>/g, "")
    .replace(/\n/g, " ")
    .trim();
  const description = rawExcerpt ? decodeHtmlEntities(rawExcerpt).slice(0, 200) : "";

  let frontMatter = "---\n";
  frontMatter += `title: ${escapeYamlString(title)}\n`;
  frontMatter += `date: ${post.date}\n`;
  frontMatter += `slug: "${post.slug}"\n`;
  if (description) {
    frontMatter += `description: ${escapeYamlString(description)}\n`;
  }
  frontMatter += "draft: false\n";
  frontMatter += "---\n";
  return frontMatter;
}

async function exportType(
  config: ResolvedConfig,
  fetchImpl: typeof fetch,
  logger: Logger,
  writerRecorder: ((callsite: string) => void) | undefined,
  wpType: string,
  section: string,
  result: CustomTypeExportResult,
): Promise<number> {
  logger.log(`\nExporting ${wpType} -> ${section}/`);
  const posts = await fetchAllPages<WPPost>(fetchImpl, config.wpApiUrl, wpType);
  logger.log(`  Found ${posts.length} items`);

  for (const post of posts) {
    const filePath = path.join(config.contentDir, section, post.slug, "index.md");
    await writeMarkdownContent({
      config,
      filePath,
      frontMatter: buildFrontMatter(post),
      html: post.content?.rendered || "",
      context: { kind: "custom-post-type", slug: post.slug },
      callsite: "export-custom-types.ts:custom-post-type",
      writerRecorder,
    });
    result.outputPaths.push(filePath);
    logger.log(`  ${post.slug}`);
  }

  return posts.length;
}

export async function runCustomTypeExport(
  config: ResolvedConfig,
  options: CustomTypeExportOptions = {},
): Promise<CustomTypeExportResult> {
  const fetchImpl = options.fetch || fetch;
  const logger = options.logger || console;
  const result: CustomTypeExportResult = {
    counts: {},
    outputPaths: [],
  };

  logger.log("=== Export Custom Post Types ===");

  if (config.customPostTypes.length === 0) {
    logger.log("No custom post types configured in wp-config.json. Nothing to export.");
    return result;
  }

  for (const { type, section } of config.customPostTypes) {
    try {
      result.counts[section] = await exportType(
        config,
        fetchImpl,
        logger,
        options.writerRecorder,
        type,
        section,
        result,
      );
    } catch (error) {
      logger.warn(`  Warning: Could not export ${type}:`, error);
      result.counts[section] = 0;
    }
  }

  logger.log("\n=== Summary ===");
  for (const [section, count] of Object.entries(result.counts)) {
    logger.log(`  ${section}: ${count}`);
  }

  return result;
}

async function main(): Promise<void> {
  await runCustomTypeExport(loadConfig());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
