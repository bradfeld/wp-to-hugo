import fs from "node:fs";
import path from "node:path";

import TurndownService from "turndown";

import { type ResolvedConfig } from "./config";
import { applyContentTransform, type TransformContext } from "./content-transform";

export interface WriteMarkdownContentOptions {
  config: ResolvedConfig;
  filePath: string;
  frontMatter: string;
  html: string;
  context: TransformContext;
  callsite: string;
  writerRecorder?: (callsite: string) => void;
}

export function decodeHtmlEntities(text: string): string {
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

export function escapeYamlString(value: string): string {
  if (/[:"'\[\]{}#&*!|>%@`]/.test(value) || value.includes("\n")) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return `"${value}"`;
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

export function htmlToMarkdown(html: string): string {
  let cleaned = html.replace(/<!--\s*\/?wp:\w+[^>]*-->/g, "");
  cleaned = cleaned.replace(/<p>\s*<\/p>/g, "");
  cleaned = cleaned.replace(/\[caption[^\]]*\](.*?)\[\/caption\]/gs, "$1");

  const td = createTurndown();
  let markdown = td.turndown(cleaned);
  markdown = markdown.replace(/\n{3,}/g, "\n\n");
  return markdown.trim();
}

export async function writeMarkdownContent({
  config,
  filePath,
  frontMatter,
  html,
  context,
  callsite,
  writerRecorder,
}: WriteMarkdownContentOptions): Promise<string> {
  writerRecorder?.(callsite);
  const transformedMarkdown = await applyContentTransform(
    htmlToMarkdown(html),
    context,
    config.contentTransform,
  );

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${frontMatter}\n${transformedMarkdown}`);
  return filePath;
}
