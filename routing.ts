import path from "node:path";

const SUPPORTED_ROUTE_TOKENS = new Set([
  ":id",
  ":year",
  ":month",
  ":day",
  ":slug",
]);

export interface PostRouteInput {
  id: number;
  date: string;
  slug: string;
}

export interface PostRoutePlan {
  bundleDir: string;
  indexFile: string;
  publicUrl: string;
  key: string;
}

interface RouteTokens {
  ":id": string;
  ":year": string;
  ":month": string;
  ":day": string;
  ":slug": string;
}

function normalizePattern(pattern: string, leadingSlash: boolean): string {
  const trimmed = pattern.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  const core = trimmed.replace(/^\/+|\/+$/g, "");
  if (!core) {
    return leadingSlash ? "/" : "";
  }
  return leadingSlash ? `/${core}/` : core;
}

function normalizeKey(pathname: string): string {
  const normalized = pathname.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  const trimmed = normalized.replace(/^\/+|\/+$/g, "");
  return decodeURIComponent(trimmed).toLowerCase();
}

function normalizePathname(pathname: string): string {
  return pathname.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

function normalizedPort(url: URL): string {
  if (url.port) {
    return url.port;
  }

  if (url.protocol === "http:") {
    return "80";
  }

  if (url.protocol === "https:") {
    return "443";
  }

  return "";
}

function siteOriginMatches(candidateUrl: URL, site: URL): boolean {
  return (
    candidateUrl.protocol === site.protocol &&
    normalizedPort(candidateUrl) === normalizedPort(site) &&
    normalizedHostname(candidateUrl.hostname) === normalizedHostname(site.hostname)
  );
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractRouteTokens(pattern: string): string[] {
  return pattern.match(/:[a-zA-Z]+/g) || [];
}

export function getRouteTokens(pattern: string): string[] {
  return [...new Set(extractRouteTokens(pattern))];
}

function buildRouteTokens(post: PostRouteInput): RouteTokens {
  const date = new Date(post.date);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid post date for route planning: ${post.date}`);
  }

  return {
    ":id": String(post.id),
    ":year": String(date.getFullYear()),
    ":month": String(date.getMonth() + 1).padStart(2, "0"),
    ":day": String(date.getDate()).padStart(2, "0"),
    ":slug": post.slug,
  };
}

function renderPattern(pattern: string, tokens: Partial<RouteTokens>): string {
  return pattern.replace(/:[a-zA-Z]+/g, (token) => {
    if (!SUPPORTED_ROUTE_TOKENS.has(token)) {
      throw new Error(`Unsupported or unresolved route token: ${token}`);
    }
    const value = tokens[token as keyof RouteTokens];
    if (!value) {
      throw new Error(`Unsupported or unresolved route token: ${token}`);
    }
    return value;
  });
}

function patternToRegex(pattern: string, leadingSlash: boolean): RegExp {
  const normalized = normalizePattern(pattern, leadingSlash);
  const parts = normalized.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  const regexBody = parts
    .map((part) => {
      if (part.startsWith(":")) {
        if (!SUPPORTED_ROUTE_TOKENS.has(part)) {
          throw new Error(`Unsupported or unresolved route token: ${part}`);
        }
        return "([^/]+)";
      }
      return escapeRegex(part);
    })
    .join("/");

  if (!regexBody) {
    return /^\/?$/;
  }

  return leadingSlash
    ? new RegExp(`^/${regexBody}/?$`, "i")
    : new RegExp(`^${regexBody}$`, "i");
}

function matchPattern(pattern: string, candidate: string, leadingSlash: boolean): boolean {
  return patternToRegex(pattern, leadingSlash).test(candidate);
}

export function assertSupportedRoutePattern(pattern: string, fieldName: string): void {
  for (const token of extractRouteTokens(pattern)) {
    if (!SUPPORTED_ROUTE_TOKENS.has(token)) {
      throw new Error(`Unsupported route token in ${fieldName}: ${token}`);
    }
  }
}

export function assertCompatibleRoutePatterns(
  contentPath: string,
  urlPath: string,
): void {
  const contentTokens = new Set(getRouteTokens(contentPath));
  const missingTokens = getRouteTokens(urlPath).filter((token) => !contentTokens.has(token));

  if (missingTokens.length > 0) {
    throw new Error(
      `postRoute.urlPath uses tokens not present in postRoute.contentPath: ${missingTokens.join(", ")}`,
    );
  }
}

export function assertUniqueRoutePattern(pattern: string, fieldName: string): void {
  const tokens = new Set(getRouteTokens(pattern));
  if (!tokens.has(":slug") && !tokens.has(":id")) {
    throw new Error(`${fieldName} must include at least one unique token (:slug or :id)`);
  }
}

export function buildPostRoutePlan(
  post: PostRouteInput,
  route: { contentPath: string; urlPath: string },
): PostRoutePlan {
  const tokens = buildRouteTokens(post);
  const bundleDir = normalizePattern(renderPattern(route.contentPath, tokens), false);
  const publicUrl = normalizePattern(renderPattern(route.urlPath, tokens), true);
  const key = normalizeKey(publicUrl);

  return {
    bundleDir,
    indexFile: path.posix.join(bundleDir, "index.md"),
    publicUrl,
    key,
  };
}

export function normalizeSiteRelativePath(url: string, siteUrl: string): string {
  const candidateUrl = new URL(url);
  const site = new URL(siteUrl);

  if (!siteOriginMatches(candidateUrl, site)) {
    return "";
  }

  const sitePath = normalizePathname(site.pathname).replace(/\/+$/g, "") || "/";
  const pathname = normalizePathname(candidateUrl.pathname);

  if (sitePath === "/") {
    return pathname;
  }

  if (pathname === sitePath) {
    return "/";
  }

  if (pathname.startsWith(`${sitePath}/`)) {
    return pathname.slice(sitePath.length) || "/";
  }

  return "";
}

export function normalizeWordPressPostUrl(url: string, urlPath: string, siteUrl?: string): string {
  const pathname = siteUrl ? normalizeSiteRelativePath(url, siteUrl) : new URL(url).pathname;
  if (!matchPattern(urlPath, pathname, true)) {
    return "";
  }
  return normalizeKey(pathname);
}

export function normalizeHugoPostPath(
  filePath: string,
  contentDir: string,
  route: { contentPath: string; urlPath: string },
): string {
  const relativePath = path.relative(contentDir, filePath).replace(/\\/g, "/");
  if (!relativePath.endsWith("/index.md")) {
    return "";
  }
  const bundleDir = relativePath.replace(/\/index\.md$/, "");
  if (!matchPattern(route.contentPath, bundleDir, false)) {
    return "";
  }

  return normalizeKey(renderPattern(route.urlPath, extractValues(route.contentPath, bundleDir)));
}

function extractValues(pattern: string, candidate: string): Partial<RouteTokens> {
  const normalizedPattern = normalizePattern(pattern, false);
  const patternParts = normalizedPattern.split("/").filter(Boolean);
  const candidateParts = candidate.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").split("/");
  const values: Partial<RouteTokens> = {};

  for (let index = 0; index < patternParts.length; index += 1) {
    const patternPart = patternParts[index];
    if (patternPart?.startsWith(":")) {
      values[patternPart as keyof RouteTokens] = candidateParts[index] || "";
    }
  }

  return values;
}
