import fs from "node:fs";
import path from "node:path";

import {
  type ResolvedConfig,
  type VerificationSource,
  type VerificationTarget,
} from "./config";
import { normalizeHugoPostPath, normalizeWordPressPostUrl } from "./routing";

export interface VerificationMatch {
  target: VerificationTarget;
  key: string;
}

export type VerificationKeySets = Record<VerificationTarget, Set<string>>;

function normalizeKey(value: string): string {
  return decodeURIComponent(value.replace(/^\/+|\/+$/g, "")).toLowerCase();
}

function normalizePathname(url: string): string {
  return new URL(url).pathname.replace(/\/{2,}/g, "/");
}

function normalizeBasePath(basePath: string): string {
  const trimmed = basePath.replace(/^\/+|\/+$/g, "");
  return trimmed ? `/${trimmed}/` : "/";
}

function isSingleSegment(pathname: string): boolean {
  const segments = pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  return segments.length === 1;
}

function walkFiles(rootDir: string, predicate: (filePath: string) => boolean): string[] {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const files: string[] = [];

  function walk(currentDir: string): void {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (predicate(fullPath)) {
        files.push(fullPath);
      }
    }
  }

  walk(rootDir);
  return files;
}

function emptyKeySets(): VerificationKeySets {
  return {
    posts: new Set<string>(),
    pages: new Set<string>(),
    categories: new Set<string>(),
  };
}

function addMatch(match: VerificationMatch | null, discovered: VerificationKeySets): void {
  if (match) {
    discovered[match.target].add(match.key);
  }
}

export function extractSitemapLocs(xml: string): string[] {
  const locRegex = /<loc>(.*?)<\/loc>/g;
  const urls: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = locRegex.exec(xml)) !== null) {
    urls.push(match[1]);
  }

  return urls;
}

export function classifySitemapUrlCandidates(
  url: string,
  config: ResolvedConfig,
): VerificationMatch[] {
  const pathname = normalizePathname(url);
  const matches: VerificationMatch[] = [];
  const targets = new Set(config.verification.targets);
  const categoryBasePath = normalizeBasePath(config.verification.categoryBasePath);

  if (targets.has("posts")) {
    const key = normalizeWordPressPostUrl(url, config.postRoute.urlPath);
    if (key) {
      matches.push({ target: "posts", key });
    }
  }

  if (targets.has("categories") && pathname.startsWith(categoryBasePath)) {
    const remainder = pathname.slice(categoryBasePath.length);
    const key = normalizeKey(remainder);
    if (key && !key.includes("/")) {
      matches.push({ target: "categories", key });
    }
  }

  if (targets.has("pages") && isSingleSegment(pathname) && !pathname.startsWith(categoryBasePath)) {
    matches.push({ target: "pages", key: normalizeKey(pathname) });
  }

  return matches;
}

export function contentPathToKey(
  filePath: string,
  contentDir: string,
  config: ResolvedConfig,
): VerificationMatch | null {
  const normalizedPath = filePath.replace(/\\/g, "/");
  const relativePath = path.relative(contentDir, filePath).replace(/\\/g, "/");

  if (relativePath.endsWith("/index.md")) {
    const postKey = normalizeHugoPostPath(filePath, contentDir, config.postRoute);
    if (postKey && config.verification.targets.includes("posts")) {
      return { target: "posts", key: postKey };
    }
  }

  if (config.verification.targets.includes("pages") && /^[^/]+\.md$/i.test(relativePath)) {
    return { target: "pages", key: normalizeKey(relativePath.replace(/\.md$/i, "")) };
  }

  if (
    config.verification.targets.includes("categories") &&
    normalizedPath.endsWith("/_index.md") &&
    /^categories\/[^/]+\/_index\.md$/i.test(relativePath)
  ) {
    return {
      target: "categories",
      key: normalizeKey(relativePath.replace(/^categories\//i, "").replace(/\/_index\.md$/i, "")),
    };
  }

  return null;
}

export function publicPathToKey(
  filePath: string,
  publicDir: string,
  config: ResolvedConfig,
): VerificationMatch | null {
  const relativePath = path.relative(publicDir, filePath).replace(/\\/g, "/");
  if (!relativePath.endsWith("/index.html")) {
    return null;
  }

  const routePath = `/${relativePath.replace(/\/index\.html$/i, "")}/`;
  const categoryBasePath = normalizeBasePath(config.verification.categoryBasePath);

  if (
    config.verification.targets.includes("categories") &&
    routePath.startsWith(categoryBasePath)
  ) {
    const remainder = routePath.slice(categoryBasePath.length);
    const key = normalizeKey(remainder);
    if (key && !key.includes("/")) {
      return { target: "categories", key };
    }
  }

  if (
    config.verification.targets.includes("pages") &&
    isSingleSegment(routePath) &&
    !routePath.startsWith(categoryBasePath)
  ) {
    return { target: "pages", key: normalizeKey(routePath) };
  }

  if (config.verification.targets.includes("posts")) {
    const postKey = normalizeWordPressPostUrl(`https://example.com${routePath}`, config.postRoute.urlPath);
    if (postKey) {
      return { target: "posts", key: postKey };
    }
  }

  return null;
}

export function collectRouteKeys(config: ResolvedConfig): VerificationKeySets {
  const discovered = emptyKeySets();
  const sources = new Set<VerificationSource>(config.verification.sources);

  if (sources.has("content")) {
    for (const filePath of walkFiles(config.contentDir, (candidate) => candidate.endsWith(".md"))) {
      addMatch(contentPathToKey(filePath, config.contentDir, config), discovered);
    }
  }

  if (sources.has("public")) {
    for (const filePath of walkFiles(config.verification.publicDir, (candidate) => candidate.endsWith("index.html"))) {
      addMatch(publicPathToKey(filePath, config.verification.publicDir, config), discovered);
    }
  }

  return discovered;
}

export function resolveVerificationMatches(
  candidates: VerificationMatch[],
  discovered: VerificationKeySets,
): VerificationMatch[] {
  if (candidates.length <= 1) {
    return candidates;
  }

  return candidates.filter((candidate) => discovered[candidate.target].has(candidate.key));
}
