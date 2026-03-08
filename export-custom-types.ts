// export-custom-types.ts
// Export custom post types from WordPress to Hugo content sections
import fs from "node:fs";
import path from "node:path";
import TurndownService from "turndown";
import { loadConfig } from "./config";

const config = loadConfig();
const WP_API = config.wpApiUrl;
const CONTENT_DIR = config.contentDir;

function decodeHtmlEntities(text: string): string {
  const map: Record<string, string> = {
    "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'",
    "&hellip;": "...", "&ndash;": "\u2013", "&mdash;": "\u2014",
    "&lsquo;": "\u2018", "&rsquo;": "\u2019", "&ldquo;": "\u201C", "&rdquo;": "\u201D",
    "&nbsp;": " ", "&copy;": "\u00A9",
  };
  let result = text;
  for (const [entity, char] of Object.entries(map)) result = result.replaceAll(entity, char);
  result = result.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return result;
}

function escapeYamlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function htmlToMarkdown(html: string): string {
  let cleaned = html.replace(/<!--\s*\/?wp:\w+[^>]*-->/g, "");
  cleaned = cleaned.replace(/<p>\s*<\/p>/g, "");
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  let md = td.turndown(cleaned);
  md = md.replace(/\n{3,}/g, "\n\n");
  return md.trim();
}

async function fetchAllPages<T>(endpoint: string): Promise<T[]> {
  const all: T[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const url = `${WP_API}/${endpoint}?per_page=100&page=${page}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`API error ${res.status}: ${url}`);
    const data = (await res.json()) as T[];
    all.push(...data);
    totalPages = parseInt(res.headers.get("X-WP-TotalPages") || "0", 10);
    page++;
  } while (page <= totalPages);
  return all;
}

interface WPPost {
  id: number;
  date: string;
  slug: string;
  title: { rendered: string };
  content: { rendered: string };
  excerpt: { rendered: string };
}

async function exportType(wpType: string, section: string): Promise<number> {
  console.log(`\nExporting ${wpType} -> ${section}/`);
  const posts = await fetchAllPages<WPPost>(wpType);
  console.log(`  Found ${posts.length} items`);

  for (const post of posts) {
    const title = decodeHtmlEntities(post.title.rendered);
    const rawExcerpt = (post.excerpt?.rendered || "")
      .replace(/<[^>]+>/g, "")
      .replace(/\n/g, " ")
      .trim();
    const description = rawExcerpt ? decodeHtmlEntities(rawExcerpt).slice(0, 200) : "";
    const md = post.content?.rendered
      ? htmlToMarkdown(post.content.rendered)
      : "";

    const postDir = path.join(CONTENT_DIR, section, post.slug);
    fs.mkdirSync(postDir, { recursive: true });

    let fm = "---\n";
    fm += `title: ${escapeYamlString(title)}\n`;
    fm += `date: ${post.date}\n`;
    fm += `slug: "${post.slug}"\n`;
    if (description) fm += `description: ${escapeYamlString(description)}\n`;
    fm += `draft: false\n`;
    fm += "---\n";

    fs.writeFileSync(path.join(postDir, "index.md"), fm + "\n" + md);
    console.log(`  ${post.slug}`);
  }
  return posts.length;
}

async function main(): Promise<void> {
  console.log("=== Export Custom Post Types ===");

  if (config.customPostTypes.length === 0) {
    console.log("No custom post types configured in wp-config.json. Nothing to export.");
    return;
  }

  const counts: Record<string, number> = {};

  for (const { type, section } of config.customPostTypes) {
    try {
      counts[section] = await exportType(type, section);
    } catch (err) {
      console.warn(`  Warning: Could not export ${type}:`, err);
      counts[section] = 0;
    }
  }

  console.log("\n=== Summary ===");
  for (const [section, count] of Object.entries(counts)) {
    console.log(`  ${section}: ${count}`);
  }
}

main().catch(console.error);
