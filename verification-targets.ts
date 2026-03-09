import fs from "node:fs";
import path from "node:path";

import {
  type ResolvedConfig,
  type VerificationSource,
  type VerificationTarget,
} from "./config";
import {
  normalizeHugoPostPath,
  normalizeSiteRelativePath,
  normalizeWordPressPostUrl,
} from "./routing";

export interface VerificationMatch {
  target: VerificationTarget;
  key: string;
}

export type VerificationKeySets = Record<VerificationTarget, Set<string>>;

function normalizeKey(value: string): string {
  return decodeURIComponent(value.replace(/^\/+|\/+$/g, "")).toLowerCase();
}

function normalizeBasePath(basePath: string): string {
  const trimmed = basePath.replace(/^\/+|\/+$/g, "");
  return trimmed ? `/${trimmed}/` : "/";
}

function isRootPath(pathname: string): boolean {
  return pathname === "/";
}

function isSingleSegment(pathname: string): boolean {
  const segments = pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  return segments.length === 1;
}

function pageKeyFromPathname(pathname: string): string {
  return normalizeKey(pathname);
}

function getReservedPageBasePaths(config: ResolvedConfig): string[] {
  return [
    normalizeBasePath(config.verification.categoryBasePath),
    ...config.customPostTypes.map(({ section }) => normalizeBasePath(section)),
  ];
}

function isReservedPageContentPath(relativePath: string, config: ResolvedConfig): boolean {
  const normalizedPath = relativePath.replace(/\\/g, "/");

  if (normalizedPath.startsWith("categories/")) {
    return true;
  }

  return config.customPostTypes.some(({ section }) => {
    const normalizedSection = section.replace(/^\/+|\/+$/g, "");
    return (
      normalizedPath === `${normalizedSection}.md` ||
      normalizedPath === `${normalizedSection}/_index.md` ||
      normalizedPath.startsWith(`${normalizedSection}/`)
    );
  });
}

function shouldTreatAsPagePath(
  pathname: string,
  postKey: string,
  reservedBasePaths: string[],
): boolean {
  if (reservedBasePaths.some((basePath) => pathname.startsWith(basePath))) {
    return false;
  }

  if (isRootPath(pathname) || isSingleSegment(pathname)) {
    return true;
  }

  return postKey === "";
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

function addMatches(matches: VerificationMatch[], discovered: VerificationKeySets): void {
  for (const match of matches) {
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
  const pathname = normalizeSiteRelativePath(url, config.siteUrl);
  if (!pathname) {
    return [];
  }

  const matches: VerificationMatch[] = [];
  const targets = new Set(config.verification.targets);
  const reservedBasePaths = getReservedPageBasePaths(config);
  const categoryBasePath = normalizeBasePath(config.verification.categoryBasePath);
  const postKey = normalizeWordPressPostUrl(url, config.postRoute.urlPath, config.siteUrl);

  if (targets.has("posts")) {
    if (postKey) {
      matches.push({ target: "posts", key: postKey });
    }
  }

  if (targets.has("categories") && pathname.startsWith(categoryBasePath)) {
    const remainder = pathname.slice(categoryBasePath.length);
    const key = normalizeKey(remainder);
    if (key) {
      matches.push({ target: "categories", key });
    }
  }

  if (
    targets.has("pages") &&
    shouldTreatAsPagePath(pathname, postKey, reservedBasePaths)
  ) {
    matches.push({ target: "pages", key: pageKeyFromPathname(pathname) });
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

  if (
    config.verification.targets.includes("pages") &&
    (
      relativePath === "_index.md" ||
      (
        relativePath.endsWith("/index.md") &&
        !isReservedPageContentPath(relativePath, config) &&
        !normalizeHugoPostPath(filePath, contentDir, config.postRoute)
      ) ||
      (/\.md$/i.test(relativePath) && !isReservedPageContentPath(relativePath, config))
    )
  ) {
    return {
      target: "pages",
      key: relativePath === "_index.md"
        ? ""
        : relativePath.endsWith("/index.md")
          ? normalizeKey(relativePath.replace(/\/index\.md$/i, ""))
          : normalizeKey(relativePath.replace(/\.md$/i, "")),
    };
  }

  if (
    config.verification.targets.includes("categories") &&
    normalizedPath.endsWith("/_index.md") &&
    /^categories\/.+\/_index\.md$/i.test(relativePath)
  ) {
    return {
      target: "categories",
      key: normalizeKey(relativePath.replace(/^categories\//i, "").replace(/\/_index\.md$/i, "")),
    };
  }

  return null;
}

export function publicPathToMatches(
  filePath: string,
  publicDir: string,
  config: ResolvedConfig,
): VerificationMatch[] {
  const relativePath = path.relative(publicDir, filePath).replace(/\\/g, "/");
  if (relativePath === "index.html") {
    if (config.verification.targets.includes("pages")) {
      return [{ target: "pages", key: "" }];
    }
    return [];
  }

  if (!relativePath.endsWith("/index.html")) {
    return [];
  }

  const routePath = `/${relativePath.replace(/\/index\.html$/i, "")}/`;
  const reservedBasePaths = getReservedPageBasePaths(config);
  const categoryBasePath = normalizeBasePath(config.verification.categoryBasePath);
  const postKey = normalizeWordPressPostUrl(`https://example.com${routePath}`, config.postRoute.urlPath);
  const matches: VerificationMatch[] = [];

  if (
    config.verification.targets.includes("categories") &&
    routePath.startsWith(categoryBasePath)
  ) {
    const remainder = routePath.slice(categoryBasePath.length);
    const key = normalizeKey(remainder);
    if (key) {
      matches.push({ target: "categories", key });
    }
  }

  if (config.verification.targets.includes("posts") && postKey) {
    matches.push({ target: "posts", key: postKey });
  }

  if (
    config.verification.targets.includes("pages") &&
    shouldTreatAsPagePath(routePath, postKey, reservedBasePaths)
  ) {
    matches.push({ target: "pages", key: pageKeyFromPathname(routePath) });
  }

  return matches;
}

export function publicPathToKey(
  filePath: string,
  publicDir: string,
  config: ResolvedConfig,
): VerificationMatch | null {
  const matches = publicPathToMatches(filePath, publicDir, config);
  return matches.length === 1 ? matches[0] : null;
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
      addMatches(publicPathToMatches(filePath, config.verification.publicDir, config), discovered);
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
