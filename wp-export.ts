import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import TurndownService from "turndown";

import { loadConfig, type ResolvedConfig } from "./config";
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
}

export interface ExportResult {
  state: ExportState;
  outputPaths: {
    posts: string[];
    customPostTypes: string[];
    pages: string[];
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

function createTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
  });

  td.addRule("wpBlockComments", {
    filter: (node) => node.nodeType === 8,
    replacement: () => "",
  });

  td.addRule("wpCaption", {
    filter: (node) => {
      const element = node as HTMLElement;
      return element.classList?.contains("wp-caption") || false;
    },
    replacement: (_content, node) => {
      const element = node as HTMLElement;
      const image = element.querySelector("img");
      const caption = element.querySelector(".wp-caption-text");
      if (!image) {
        return "";
      }
      const alt = caption?.textContent || image.alt || "";
      return `\n\n![${alt}](${image.src})\n\n`;
    },
  });

  return td;
}

function htmlToMarkdown(html: string): string {
  let cleaned = html.replace(/<!--\s*\/?wp:\w+[^>]*-->/g, "");
  cleaned = cleaned.replace(/<p>\s*<\/p>/g, "");
  cleaned = cleaned.replace(/\[caption[^\]]*\](.*?)\[\/caption\]/gs, "$1");

  const td = createTurndown();
  let markdown = td.turndown(cleaned);
  markdown = markdown.replace(/\n{3,}/g, "\n\n");
  return markdown.trim();
}

function decodeHtmlEntities(text: string): string {
  const entityMap: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&apos;": "'",
    "&hellip;": "...",
    "&ndash;": "\u2013",
    "&mdash;": "\u2014",
    "&lsquo;": "\u2018",
    "&rsquo;": "\u2019",
    "&ldquo;": "\u201C",
    "&rdquo;": "\u201D",
    "&nbsp;": " ",
    "&copy;": "\u00A9",
  };
  let result = text;
  for (const [entity, char] of Object.entries(entityMap)) {
    result = result.replaceAll(entity, char);
  }
  result = result.replace(/&#(\d+);/g, (_match, numeric) => String.fromCharCode(parseInt(numeric, 10)));
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
  return result;
}

function escapeYamlString(value: string): string {
  if (/[:"'\[\]{}#&*!|>%@`]/.test(value) || value.includes("\n")) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return `"${value}"`;
}

function generateFrontmatter(
  post: WPPost,
  categoryMap: Map<number, string>,
  tagMap: Map<number, string>,
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

  return frontmatter;
}

function writeBundle(filePath: string, frontmatter: string, markdown: string): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${frontmatter}\n${markdown}`);
  return filePath;
}

function writePost(
  config: ResolvedConfig,
  post: WPPost,
  markdown: string,
  frontmatter: string,
  section = "archives",
): string {
  if (section !== "archives") {
    const filePath = path.join(config.contentDir, section, post.slug, "index.md");
    return writeBundle(filePath, frontmatter, markdown);
  }

  const routePlan = buildPostRoutePlan(post, config.postRoute);
  const filePath = path.join(config.contentDir, ...routePlan.indexFile.split("/"));
  return writeBundle(filePath, frontmatter, markdown);
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
): Promise<void> {
  logger.log("Phase 2: Exporting blog posts...");

  let page = state.lastPage > 0 ? state.lastPage : 1;
  const firstUrl = `${config.wpApiUrl}/posts?per_page=100&page=${page}&orderby=date&order=asc`;
  const firstPage = await fetchJSON<WPPost[]>(fetchImpl, firstUrl);
  state.totalPosts = firstPage.total;
  logger.log(`  Total posts: ${firstPage.total} (${firstPage.totalPages} pages)`);

  for (const post of firstPage.data) {
    const filePath = writePost(
      config,
      post,
      htmlToMarkdown(post.content.rendered),
      generateFrontmatter(post, categoryMap, tagMap),
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
      const filePath = writePost(
        config,
        post,
        htmlToMarkdown(post.content.rendered),
        generateFrontmatter(post, categoryMap, tagMap),
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
): Promise<number> {
  logger.log(`  Exporting custom post type: ${type} -> ${section}/`);

  try {
    const posts = await fetchAllPages<WPPost>(fetchImpl, config.wpApiUrl, type, logger);
    for (const post of posts) {
      const filePath = writePost(
        config,
        post,
        htmlToMarkdown(post.content.rendered),
        generateFrontmatter(post, categoryMap, tagMap),
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

function writePage(config: ResolvedConfig, page: WPPost, markdown: string): string {
  const pageRoute = resolvePageRoute(config, page.link);
  const filePath = path.join(config.contentDir, ...pageRoute.pathSegments);
  let frontmatter =
    `---\ntitle: ${escapeYamlString(page.title.rendered)}\ndate: ${page.date}\n`;
  if (pageRoute.slug) {
    frontmatter += `slug: "${pageRoute.slug}"\n`;
  }
  frontmatter += 'layout: "page"\n---\n';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${frontmatter}\n${markdown}`);
  return filePath;
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
    outputPaths: {
      posts: [],
      customPostTypes: [],
      pages: [],
    },
  };

  logger.log("=== WordPress to Hugo Export ===\n");
  logger.log(`Resuming from state: ${JSON.stringify(state)}\n`);

  const { categoryMap, tagMap } = await exportTaxonomies(config, fetchImpl, logger);
  state.categoriesLoaded = true;
  state.tagsLoaded = true;
  saveState(stateFile, state);

  if (state.phase !== "posts_done") {
    await exportPosts(config, fetchImpl, logger, stateFile, categoryMap, tagMap, state, result);
    state.phase = "posts_done";
    saveState(stateFile, state);
  }

  logger.log("\nPhase 3: Exporting custom post types...");
  for (const { type, section } of config.customPostTypes) {
    if (!state.customTypesExported.includes(type)) {
      await exportCustomPostType(config, fetchImpl, logger, type, section, categoryMap, tagMap, result);
      state.customTypesExported.push(type);
      saveState(stateFile, state);
    }
  }

  logger.log("\nPhase 4: Exporting static pages...");
  const pages = await fetchAllPages<WPPost>(fetchImpl, config.wpApiUrl, "pages", logger);
  for (const page of pages) {
    const filePath = writePage(config, page, htmlToMarkdown(page.content.rendered));
    result.outputPaths.pages.push(filePath);
    logger.log(`  Exported page: ${page.slug}`);
  }

  state.phase = "complete";
  saveState(stateFile, state);

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
