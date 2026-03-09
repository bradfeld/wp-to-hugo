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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractRouteTokens(pattern: string): string[] {
  return pattern.match(/:[a-zA-Z]+/g) || [];
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

export function normalizeWordPressPostUrl(url: string, urlPath: string): string {
  const pathname = new URL(url).pathname;
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
