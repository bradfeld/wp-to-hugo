import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  appendAuthorFrontMatter,
  loadAuthorExportState,
  removeAuthorDataFile,
  writeAuthorDataFile,
  type AuthorExportState,
} from "./authors";
import { loadConfig, type ResolvedConfig } from "./config";
import { decodeHtmlEntities, escapeYamlString, writeMarkdownContent } from "./export-content";
import { buildPostRoutePlan, normalizeSiteRelativePath } from "./routing";

interface WPPost {
  id: number;
  date: string;
  slug: string;
  status: string;
  title: { rendered: string };
  content: { rendered: string };
  excerpt: { rendered: string };
  categories: number[];
  tags: number[];
  author?: number;
  featured_media: number;
  link: string;
}

interface WPTerm {
  id: number;
  name: string;
  slug: string;
  count: number;
  parent?: number;
}

interface ExportState {
  phase: string;
  postsExported: number;
  totalPosts: number;
  lastPage: number;
  categoriesLoaded: boolean;
  tagsLoaded: boolean;
  customTypesExported: string[];
}

interface Logger {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface ExportOptions {
  fetch?: typeof fetch;
  logger?: Logger;
  stateFile?: string;
  writerRecorder?: (callsite: string) => void;
}

export interface ExportResult {
  state: ExportState;
  warnings: string[];
  outputPaths: {
    posts: string[];
    customPostTypes: string[];
    pages: string[];
    authorData?: string;
  };
}

const DELAY_MS = 100;

function createInitialState(): ExportState {
  return {
    phase: "init",
    postsExported: 0,
    totalPosts: 0,
    lastPage: 0,
    categoriesLoaded: false,
    tagsLoaded: false,
    customTypesExported: [],
  };
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateFrontmatter(
  post: WPPost,
  categoryMap: Map<number, string>,
  tagMap: Map<number, string>,
  authorSlug?: string,
  config?: ResolvedConfig,
): string {
  const categories = post.categories.map((id) => categoryMap.get(id)).filter(Boolean);
  const tags = post.tags.map((id) => tagMap.get(id)).filter(Boolean);
  const title = decodeHtmlEntities(post.title.rendered);
  const excerpt = decodeHtmlEntities(
    post.excerpt.rendered.replace(/<[^>]+>/g, "").replace(/\n/g, " ").trim(),
  );
  const description = excerpt.slice(0, 200);

  let frontmatter = "---\n";
  frontmatter += `title: ${escapeYamlString(title)}\n`;
  frontmatter += `date: ${post.date}\n`;
  frontmatter += `slug: "${post.slug}"\n`;
  if (categories.length > 0) {
    frontmatter += `categories: [${categories.map((value) => escapeYamlString(value!)).join(", ")}]\n`;
  }
  if (tags.length > 0) {
    frontmatter += `tags: [${tags.map((value) => escapeYamlString(value!)).join(", ")}]\n`;
  }
  if (description) {
    frontmatter += `description: ${escapeYamlString(description)}\n`;
  }
  frontmatter += "draft: false\n";
  frontmatter += "---\n";

  return config
    ? appendAuthorFrontMatter(frontmatter, authorSlug, config.authorExport)
    : frontmatter;
}

async function writePost(
  config: ResolvedConfig,
  post: WPPost,
  html: string,
  frontmatter: string,
  writerRecorder: ((callsite: string) => void) | undefined,
  section = "archives",
): Promise<string> {
  if (section !== "archives") {
    const filePath = path.join(config.contentDir, section, post.slug, "index.md");
    return writeMarkdownContent({
      config,
      filePath,
      frontMatter: frontmatter,
      html,
      context: { kind: "custom-post-type", slug: post.slug, sourceUrl: post.link },
      callsite: "wp-export.ts:custom-post-type",
      writerRecorder,
    });
  }

  const routePlan = buildPostRoutePlan(post, config.postRoute);
  const filePath = path.join(config.contentDir, ...routePlan.indexFile.split("/"));
  return writeMarkdownContent({
    config,
    filePath,
    frontMatter: frontmatter,
    html,
    context: { kind: "post", slug: post.slug, sourceUrl: post.link },
    callsite: "wp-export.ts:post",
    writerRecorder,
  });
}

function loadState(stateFile: string): ExportState {
  if (!fs.existsSync(stateFile)) {
    return createInitialState();
  }
  return JSON.parse(fs.readFileSync(stateFile, "utf-8")) as ExportState;
}

function saveState(stateFile: string, state: ExportState): void {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

async function fetchJSON<T>(
  fetchImpl: typeof fetch,
  url: string,
): Promise<{ data: T; total: number; totalPages: number }> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`API error ${response.status}: ${url}`);
  }
  const data = await response.json() as T;
  const total = parseInt(response.headers.get("X-WP-Total") || "0", 10);
  const totalPages = parseInt(response.headers.get("X-WP-TotalPages") || "0", 10);
  return { data, total, totalPages };
}

async function fetchAllPages<T>(
  fetchImpl: typeof fetch,
  wpApiUrl: string,
  endpoint: string,
  logger: Logger,
  params = "",
): Promise<T[]> {
  const all: T[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const separator = params ? "&" : "?";
    const url = `${wpApiUrl}/${endpoint}?per_page=100&page=${page}${params ? separator + params : ""}`;
    logger.log(`  Fetching ${endpoint} page ${page}/${totalPages}...`);
    const result = await fetchJSON<T[]>(fetchImpl, url);
    all.push(...result.data);
    totalPages = result.totalPages;
    page += 1;
    await delay(DELAY_MS);
  } while (page <= totalPages);

  return all;
}

async function exportTaxonomies(
  config: ResolvedConfig,
  fetchImpl: typeof fetch,
  logger: Logger,
): Promise<{ categoryMap: Map<number, string>; tagMap: Map<number, string> }> {
  logger.log("Phase 1: Loading taxonomies...");

  const categories = await fetchAllPages<WPTerm>(fetchImpl, config.wpApiUrl, "categories", logger);
  const tags = await fetchAllPages<WPTerm>(fetchImpl, config.wpApiUrl, "tags", logger);

  return {
    categoryMap: new Map(categories.map((category) => [category.id, category.name])),
    tagMap: new Map(tags.map((tag) => [tag.id, tag.name])),
  };
}

async function exportPosts(
  config: ResolvedConfig,
  fetchImpl: typeof fetch,
  logger: Logger,
  stateFile: string,
  categoryMap: Map<number, string>,
  tagMap: Map<number, string>,
  state: ExportState,
  result: ExportResult,
  authorState: AuthorExportState,
  writerRecorder: ((callsite: string) => void) | undefined,
): Promise<void> {
  logger.log("Phase 2: Exporting blog posts...");
  const missingAuthorIds = new Set<number>();

  let page = state.lastPage > 0 ? state.lastPage : 1;
  const firstUrl = `${config.wpApiUrl}/posts?per_page=100&page=${page}&orderby=date&order=asc`;
  const firstPage = await fetchJSON<WPPost[]>(fetchImpl, firstUrl);
  state.totalPosts = firstPage.total;
  logger.log(`  Total posts: ${firstPage.total} (${firstPage.totalPages} pages)`);

  for (const post of firstPage.data) {
    const filePath = await writePost(
      config,
      post,
      post.content.rendered,
      generateFrontmatter(
        post,
        categoryMap,
        tagMap,
        resolveAuthorSlug(post, authorState, missingAuthorIds, logger, result),
        config,
      ),
      writerRecorder,
    );
    result.outputPaths.posts.push(filePath);
    state.postsExported += 1;
  }

  state.lastPage = page;
  saveState(stateFile, state);
  page += 1;

  while (page <= firstPage.totalPages) {
    await delay(DELAY_MS);
    const url = `${config.wpApiUrl}/posts?per_page=100&page=${page}&orderby=date&order=asc`;
    logger.log(`  Page ${page}/${firstPage.totalPages} (${state.postsExported} exported so far)...`);
    const pageResult = await fetchJSON<WPPost[]>(fetchImpl, url);

    for (const post of pageResult.data) {
      const filePath = await writePost(
        config,
        post,
        post.content.rendered,
        generateFrontmatter(
          post,
          categoryMap,
          tagMap,
          resolveAuthorSlug(post, authorState, missingAuthorIds, logger, result),
          config,
        ),
        writerRecorder,
      );
      result.outputPaths.posts.push(filePath);
      state.postsExported += 1;
    }

    state.lastPage = page;
    saveState(stateFile, state);
    page += 1;
  }

  logger.log(`  Done! Exported ${state.postsExported} posts.`);
}

async function exportCustomPostType(
  config: ResolvedConfig,
  fetchImpl: typeof fetch,
  logger: Logger,
  type: string,
  section: string,
  categoryMap: Map<number, string>,
  tagMap: Map<number, string>,
  result: ExportResult,
  authorState: AuthorExportState,
  writerRecorder: ((callsite: string) => void) | undefined,
): Promise<number> {
  logger.log(`  Exporting custom post type: ${type} -> ${section}/`);
  const missingAuthorIds = new Set<number>();

  try {
    const posts = await fetchAllPages<WPPost>(fetchImpl, config.wpApiUrl, type, logger);
    for (const post of posts) {
      const filePath = await writePost(
        config,
        post,
        post.content.rendered,
        generateFrontmatter(
          post,
          categoryMap,
          tagMap,
          resolveAuthorSlug(post, authorState, missingAuthorIds, logger, result),
          config,
        ),
        writerRecorder,
        section,
      );
      result.outputPaths.customPostTypes.push(filePath);
    }
    logger.log(`  Exported ${posts.length} ${type} items`);
    return posts.length;
  } catch (error) {
    logger.warn(`  Warning: Could not export ${type} (may not be exposed via REST API):`, error);
    return 0;
  }
}

async function writePage(
  config: ResolvedConfig,
  page: WPPost,
  writerRecorder: ((callsite: string) => void) | undefined,
): Promise<string> {
  const pageRoute = resolvePageRoute(config, page.link);
  const filePath = path.join(config.contentDir, ...pageRoute.pathSegments);
  let frontmatter =
    `---\ntitle: ${escapeYamlString(decodeHtmlEntities(page.title.rendered))}\ndate: ${page.date}\n`;
  if (pageRoute.slug) {
    frontmatter += `slug: "${pageRoute.slug}"\n`;
  }
  frontmatter += 'layout: "page"\n---\n';
  return writeMarkdownContent({
    config,
    filePath,
    frontMatter: frontmatter,
    html: page.content.rendered,
    context: { kind: "page", slug: page.slug, sourceUrl: page.link },
    callsite: "wp-export.ts:page",
    writerRecorder,
  });
}

function resolvePageRoute(
  config: ResolvedConfig,
  pageUrl: string,
): { pathSegments: string[]; slug?: string } {
  const relativePath = normalizeSiteRelativePath(pageUrl, config.siteUrl);
  if (!relativePath) {
    throw new Error(`Page URL does not match siteUrl base path: ${pageUrl}`);
  }

  const trimmedPath = relativePath.replace(/^\/+|\/+$/g, "");
  if (!trimmedPath) {
    return { pathSegments: ["_index.md"] };
  }

  const segments = trimmedPath.split("/");
  const slug = segments[segments.length - 1];
  segments[segments.length - 1] = `${slug}.md`;
  return { pathSegments: segments, slug };
}

function addWarning(result: ExportResult, logger: Logger, message: string): void {
  result.warnings.push(message);
  logger.warn(message);
}

function resolveAuthorSlug(
  post: WPPost,
  authorState: AuthorExportState,
  missingAuthorIds: Set<number>,
  logger: Logger,
  result: ExportResult,
): string | undefined {
  if (!authorState.enabledForRun || !post.author) {
    return undefined;
  }

  const author = authorState.authorMap.get(post.author);
  if (author) {
    return author.slug;
  }

  if (!missingAuthorIds.has(post.author)) {
    missingAuthorIds.add(post.author);
    addWarning(result, logger, `Missing author mapping for WordPress author ID ${post.author}`);
  }

  return undefined;
}

export async function runExport(
  config: ResolvedConfig,
  options: ExportOptions = {},
): Promise<ExportResult> {
  const fetchImpl = options.fetch || fetch;
  const logger = options.logger || console;
  const stateFile = options.stateFile || path.resolve(process.cwd(), ".export-state.json");
  const state = loadState(stateFile);
  const result: ExportResult = {
    state,
    warnings: [],
    outputPaths: {
      posts: [],
      customPostTypes: [],
      pages: [],
      authorData: undefined,
    },
  };

  logger.log("=== WordPress to Hugo Export ===\n");
  logger.log(`Resuming from state: ${JSON.stringify(state)}\n`);

  const authorState = await loadAuthorExportState(config, fetchImpl, (message) => addWarning(result, logger, message));
  if (config.authorExport.enabled && !authorState.enabledForRun) {
    removeAuthorDataFile(config.authorExport.dataFile);
  }
  const { categoryMap, tagMap } = await exportTaxonomies(config, fetchImpl, logger);
  state.categoriesLoaded = true;
  state.tagsLoaded = true;
  saveState(stateFile, state);

  if (state.phase !== "posts_done") {
    await exportPosts(
      config,
      fetchImpl,
      logger,
      stateFile,
      categoryMap,
      tagMap,
      state,
      result,
      authorState,
      options.writerRecorder,
    );
    state.phase = "posts_done";
    saveState(stateFile, state);
  }

  logger.log("\nPhase 3: Exporting custom post types...");
  for (const { type, section } of config.customPostTypes) {
    if (!state.customTypesExported.includes(type)) {
      await exportCustomPostType(
        config,
        fetchImpl,
        logger,
        type,
        section,
        categoryMap,
        tagMap,
        result,
        authorState,
        options.writerRecorder,
      );
      state.customTypesExported.push(type);
      saveState(stateFile, state);
    }
  }

  logger.log("\nPhase 4: Exporting static pages...");
  const pages = await fetchAllPages<WPPost>(fetchImpl, config.wpApiUrl, "pages", logger);
  for (const page of pages) {
    const filePath = await writePage(config, page, options.writerRecorder);
    result.outputPaths.pages.push(filePath);
    logger.log(`  Exported page: ${page.slug}`);
  }

  state.phase = "complete";
  saveState(stateFile, state);

  if (authorState.enabledForRun) {
    writeAuthorDataFile(config.authorExport.dataFile, authorState.authorMap);
    result.outputPaths.authorData = config.authorExport.dataFile;
  }

  logger.log("\n=== Export complete! ===");
  logger.log(`Posts: ${state.postsExported}`);
  logger.log(`Custom types: ${state.customTypesExported.join(", ")}`);
  logger.log(`Pages: ${pages.length}`);

  return result;
}

async function main(): Promise<void> {
  await runExport(loadConfig());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
