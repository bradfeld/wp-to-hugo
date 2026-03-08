// scripts/fix-entities.ts
// Fix HTML entities in frontmatter description fields across all posts
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config";

const CONTENT_DIR = loadConfig().contentDir;

// Comprehensive HTML entity map
const ENTITY_MAP: Record<string, string> = {
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
  "&reg;": "\u00AE",
  "&trade;": "\u2122",
  "&bull;": "\u2022",
  "&middot;": "\u00B7",
  "&laquo;": "\u00AB",
  "&raquo;": "\u00BB",
  "&frac12;": "\u00BD",
  "&frac14;": "\u00BC",
  "&frac34;": "\u00BE",
  "&times;": "\u00D7",
  "&divide;": "\u00F7",
};

function decodeHtmlEntities(text: string): string {
  // Decode named entities
  let result = text;
  for (const [entity, char] of Object.entries(ENTITY_MAP)) {
    result = result.replaceAll(entity, char);
  }

  // Decode numeric entities (&#8217; &#8211; etc.)
  result = result.replace(/&#(\d+);/g, (_match, num) => {
    return String.fromCharCode(parseInt(num, 10));
  });

  // Decode hex entities (&#x2019; etc.)
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_match, hex) => {
    return String.fromCharCode(parseInt(hex, 16));
  });

  return result;
}

function walkContent(dir: string): string[] {
  const files: string[] = [];
  function walk(d: string): void {
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name === "index.md" || entry.name === "_index.md") {
        files.push(fullPath);
      }
    }
  }
  walk(dir);
  return files;
}

function reEscapeYamlStrings(frontmatter: string): string {
  // After decoding entities, double-quoted YAML values may contain
  // unescaped inner quotes. Fix lines like:
  //   description: "text with "inner quotes" here"
  // by escaping inner quotes:
  //   description: "text with \"inner quotes\" here"
  return frontmatter.replace(
    /^((?:title|description):\s*)"(.*)"$/gm,
    (_match, prefix: string, inner: string) => {
      // The regex captured everything between the FIRST and LAST quote.
      // Unescape any previously escaped quotes first to avoid double-escaping,
      // then re-escape all inner quotes.
      const unescaped = inner.replace(/\\"/g, '"');
      const escaped = unescaped.replace(/"/g, '\\"');
      return `${prefix}"${escaped}"`;
    },
  );
}

function fixFile(filePath: string): boolean {
  const content = fs.readFileSync(filePath, "utf-8");

  // Split frontmatter from body
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fmMatch) return false;

  const frontmatter = fmMatch[1];
  const rest = content.slice(fmMatch[0].length);

  // Decode entities in frontmatter, then re-escape for YAML safety
  let fixedFrontmatter = decodeHtmlEntities(frontmatter);
  fixedFrontmatter = reEscapeYamlStrings(fixedFrontmatter);

  if (fixedFrontmatter === frontmatter) return false;

  const fixedContent = `---\n${fixedFrontmatter}\n---\n${rest}`;
  fs.writeFileSync(filePath, fixedContent);
  return true;
}

async function main(): Promise<void> {
  console.log("=== Fix HTML Entities in Frontmatter ===\n");

  const files = walkContent(CONTENT_DIR);
  console.log(`Found ${files.length} content files\n`);

  let fixed = 0;
  let unchanged = 0;

  for (const file of files) {
    if (fixFile(file)) {
      fixed++;
    } else {
      unchanged++;
    }
  }

  console.log(`Fixed: ${fixed}`);
  console.log(`Unchanged: ${unchanged}`);
  console.log(`Total: ${files.length}`);
}

main().catch(console.error);
