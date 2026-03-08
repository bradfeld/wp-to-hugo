// wp-export.ts
import fs from "node:fs";
import path from "node:path";
import TurndownService from "turndown";
import { loadConfig } from "./config";

const config = loadConfig();
const WP_API = config.wpApiUrl;
const CONTENT_DIR = config.contentDir;
const STATE_FILE = path.resolve(process.cwd(), ".export-state.json");
const DELAY_MS = 100; // Rate limiting between API calls

// --- Types ---

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

// --- Utilities ---

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJSON<T>(
  url: string,
): Promise<{ data: T; total: number; totalPages: number }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API error ${res.status}: ${url}`);
  const data = (await res.json()) as T;
  const total = parseInt(res.headers.get("X-WP-Total") || "0", 10);
  const totalPages = parseInt(res.headers.get("X-WP-TotalPages") || "0", 10);
  return { data, total, totalPages };
}

async function fetchAllPages<T>(
  endpoint: string,
  params = "",
): Promise<T[]> {
  const all: T[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const separator = params ? "&" : "?";
    const url = `${WP_API}/${endpoint}?per_page=100&page=${page}${params ? separator + params : ""}`;
    console.log(`  Fetching ${endpoint} page ${page}/${totalPages}...`);
    const result = await fetchJSON<T[]>(url);
    all.push(...result.data);
    totalPages = result.totalPages;
    page++;
    await delay(DELAY_MS);
  } while (page <= totalPages);

  return all;
}

function loadState(): ExportState {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  }
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

function saveState(state: ExportState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// --- HTML to Markdown ---

function createTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
  });

  // Strip WordPress block comments
  td.addRule("wpBlockComments", {
    filter: (node) => {
      return node.nodeType === 8; // Comment node
    },
    replacement: () => "",
  });

  // Handle WordPress caption shortcode remnants
  td.addRule("wpCaption", {
    filter: (node) => {
      const el = node as HTMLElement;
      return el.classList?.contains("wp-caption") || false;
    },
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const img = el.querySelector("img");
      const caption = el.querySelector(".wp-caption-text");
      if (img) {
        const alt = caption?.textContent || img.alt || "";
        return `\n\n![${alt}](${img.src})\n\n`;
      }
      return "";
    },
  });

  return td;
}

function htmlToMarkdown(html: string): string {
  // Strip WordPress block comments before turndown
  let cleaned = html.replace(/<!--\s*\/?wp:\w+[^>]*-->/g, "");
  // Strip empty paragraphs
  cleaned = cleaned.replace(/<p>\s*<\/p>/g, "");
  // Convert WordPress shortcodes we can handle
  cleaned = cleaned.replace(/\[caption[^\]]*\](.*?)\[\/caption\]/gs, "$1");

  const td = createTurndown();
  let md = td.turndown(cleaned);

  // Clean up excessive newlines
  md = md.replace(/\n{3,}/g, "\n\n");

  return md.trim();
}

// --- Post Writer ---

function decodeHtmlEntities(text: string): string {
  const entityMap: Record<string, string> = {
    "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'",
    "&hellip;": "...", "&ndash;": "\u2013", "&mdash;": "\u2014",
    "&lsquo;": "\u2018", "&rsquo;": "\u2019", "&ldquo;": "\u201C",
    "&rdquo;": "\u201D", "&nbsp;": " ", "&copy;": "\u00A9",
  };
  let result = text;
  for (const [entity, char] of Object.entries(entityMap)) {
    result = result.replaceAll(entity, char);
  }
  result = result.replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(parseInt(n, 10)));
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
  return result;
}

function escapeYamlString(s: string): string {
  // If string contains special chars, wrap in double quotes
  if (/[:"'\[\]{}#&*!|>%@`]/.test(s) || s.includes("\n")) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return `"${s}"`;
}

function generateFrontmatter(
  post: WPPost,
  categoryMap: Map<number, string>,
  tagMap: Map<number, string>,
): string {
  const categories = post.categories
    .map((id) => categoryMap.get(id))
    .filter(Boolean);
  const tags = post.tags.map((id) => tagMap.get(id)).filter(Boolean);

  // Decode HTML entities in title
  const title = decodeHtmlEntities(post.title.rendered);

  // Extract first sentence for description if no excerpt
  const excerpt = decodeHtmlEntities(
    post.excerpt.rendered
      .replace(/<[^>]+>/g, "")
      .replace(/\n/g, " ")
      .trim()
  );
  const description = excerpt.slice(0, 200);

  let fm = "---\n";
  fm += `title: ${escapeYamlString(title)}\n`;
  fm += `date: ${post.date}\n`;
  fm += `slug: "${post.slug}"\n`;
  if (categories.length > 0) {
    fm += `categories: [${categories.map((c) => escapeYamlString(c!)).join(", ")}]\n`;
  }
  if (tags.length > 0) {
    fm += `tags: [${tags.map((t) => escapeYamlString(t!)).join(", ")}]\n`;
  }
  if (description) {
    fm += `description: ${escapeYamlString(description)}\n`;
  }
  fm += `draft: false\n`;
  fm += "---\n";

  return fm;
}

function writePost(
  post: WPPost,
  markdown: string,
  frontmatter: string,
  section: string = "archives",
): string {
  // Parse date for directory structure
  const date = new Date(post.date);
  const year = date.getFullYear().toString();
  const month = (date.getMonth() + 1).toString().padStart(2, "0");

  let postDir: string;
  if (section === "archives") {
    // Blog posts: content/archives/YYYY/MM/slug/index.md
    postDir = path.join(CONTENT_DIR, "archives", year, month, post.slug);
  } else {
    // Custom post types: content/section/slug/index.md
    postDir = path.join(CONTENT_DIR, section, post.slug);
  }

  fs.mkdirSync(postDir, { recursive: true });

  const filePath = path.join(postDir, "index.md");
  fs.writeFileSync(filePath, frontmatter + "\n" + markdown);

  return filePath;
}

// --- Main Export ---

async function exportTaxonomies(): Promise<{
  categoryMap: Map<number, string>;
  tagMap: Map<number, string>;
}> {
  console.log("Phase 1: Loading taxonomies...");

  const categories = await fetchAllPages<WPTerm>("categories");
  const categoryMap = new Map<number, string>();
  for (const cat of categories) {
    categoryMap.set(cat.id, cat.name);
  }
  console.log(`  Loaded ${categories.length} categories`);

  const tags = await fetchAllPages<WPTerm>("tags");
  const tagMap = new Map<number, string>();
  for (const tag of tags) {
    tagMap.set(tag.id, tag.name);
  }
  console.log(`  Loaded ${tags.length} tags`);

  return { categoryMap, tagMap };
}

async function exportPosts(
  categoryMap: Map<number, string>,
  tagMap: Map<number, string>,
  state: ExportState,
): Promise<void> {
  console.log("Phase 2: Exporting blog posts...");

  let page = state.lastPage > 0 ? state.lastPage : 1;
  let totalPages = 1;
  let exported = state.postsExported;

  // First request to get totals
  const firstUrl = `${WP_API}/posts?per_page=100&page=${page}&orderby=date&order=asc`;
  const first = await fetchJSON<WPPost[]>(firstUrl);
  totalPages = first.totalPages;
  state.totalPosts = first.total;
  console.log(`  Total posts: ${first.total} (${totalPages} pages)`);

  // Process first page
  for (const post of first.data) {
    const md = htmlToMarkdown(post.content.rendered);
    const fm = generateFrontmatter(post, categoryMap, tagMap);
    writePost(post, md, fm);
    exported++;
  }

  state.lastPage = page;
  state.postsExported = exported;
  saveState(state);
  console.log(`  Exported ${exported}/${state.totalPosts} posts`);

  page++;

  // Remaining pages
  while (page <= totalPages) {
    await delay(DELAY_MS);
    const url = `${WP_API}/posts?per_page=100&page=${page}&orderby=date&order=asc`;
    console.log(
      `  Page ${page}/${totalPages} (${exported} exported so far)...`,
    );

    try {
      const result = await fetchJSON<WPPost[]>(url);
      for (const post of result.data) {
        const md = htmlToMarkdown(post.content.rendered);
        const fm = generateFrontmatter(post, categoryMap, tagMap);
        writePost(post, md, fm);
        exported++;
      }
    } catch (err) {
      console.error(`  Error on page ${page}:`, err);
      state.lastPage = page;
      state.postsExported = exported;
      saveState(state);
      console.log(`  State saved. Resume from page ${page}.`);
      throw err;
    }

    state.lastPage = page;
    state.postsExported = exported;
    saveState(state);
    page++;
  }

  console.log(`  Done! Exported ${exported} posts.`);
}

async function exportCustomPostType(
  type: string,
  section: string,
  categoryMap: Map<number, string>,
  tagMap: Map<number, string>,
): Promise<number> {
  console.log(`  Exporting custom post type: ${type} -> ${section}/`);

  try {
    const posts = await fetchAllPages<WPPost>(type);
    let count = 0;
    for (const post of posts) {
      const md = htmlToMarkdown(post.content.rendered);
      const fm = generateFrontmatter(post, categoryMap, tagMap);
      writePost(post, md, fm, section);
      count++;
    }
    console.log(`  Exported ${count} ${type} items`);
    return count;
  } catch (err) {
    console.warn(
      `  Warning: Could not export ${type} (may not be exposed via REST API):`,
      err,
    );
    return 0;
  }
}

async function main(): Promise<void> {
  console.log("=== WordPress to Hugo Export ===\n");

  const state = loadState();
  console.log(`Resuming from state: ${JSON.stringify(state)}\n`);

  // Phase 1: Taxonomies
  const { categoryMap, tagMap } = await exportTaxonomies();
  state.categoriesLoaded = true;
  state.tagsLoaded = true;
  saveState(state);

  // Phase 2: Blog posts
  if (state.phase !== "posts_done") {
    await exportPosts(categoryMap, tagMap, state);
    state.phase = "posts_done";
    saveState(state);
  }

  // Phase 3: Custom post types
  console.log("\nPhase 3: Exporting custom post types...");

  const customTypes = config.customPostTypes;

  for (const { type, section } of customTypes) {
    if (!state.customTypesExported.includes(type)) {
      await exportCustomPostType(type, section, categoryMap, tagMap);
      state.customTypesExported.push(type);
      saveState(state);
    }
  }

  // Phase 4: Static pages
  console.log("\nPhase 4: Exporting static pages...");
  const pages = await fetchAllPages<WPPost>("pages");
  for (const page of pages) {
    const md = htmlToMarkdown(page.content.rendered);
    // Static pages go to content root
    const filePath = path.join(CONTENT_DIR, `${page.slug}.md`);
    const fm = `---\ntitle: ${escapeYamlString(page.title.rendered)}\ndate: ${page.date}\nslug: "${page.slug}"\nlayout: "page"\n---\n`;
    fs.writeFileSync(filePath, fm + "\n" + md);
    console.log(`  Exported page: ${page.slug}`);
  }

  state.phase = "complete";
  saveState(state);

  console.log("\n=== Export complete! ===");
  console.log(`Posts: ${state.postsExported}`);
  console.log(`Custom types: ${state.customTypesExported.join(", ")}`);
  console.log(`Pages: ${pages.length}`);
}

main().catch(console.error);
