import fs from "node:fs";
import path from "node:path";

import {
  assertCompatibleRoutePatterns,
  assertSupportedRoutePattern,
  assertUniqueRoutePattern,
} from "./routing";

export interface RoutePatternConfig {
  contentPath: string;
  urlPath: string;
}

export type VerificationTarget = "posts" | "pages" | "categories" | "authors";
export type VerificationSource = "content" | "public";

export interface VerificationConfig {
  targets: VerificationTarget[];
  sources: VerificationSource[];
  publicDir: string;
  categoryBasePath: string;
  authorBasePath: string;
}

export interface AuthorExportConfig {
  enabled: boolean;
  frontMatterField: string;
  dataFile: string;
}

interface WpToHugoConfig {
  siteUrl: string;
  contentDir?: string;
  postRoute?: Partial<RoutePatternConfig>;
  verification?: {
    targets?: VerificationTarget[];
    sources?: VerificationSource[];
    publicDir?: string;
    categoryBasePath?: string;
    authorBasePath?: string;
  };
  authorExport?: {
    enabled?: boolean;
    frontMatterField?: string;
    dataFile?: string;
  };
  customPostTypes?: Array<{ type: string; section: string }>;
}

export interface ResolvedConfig {
  configPath: string;
  configDir: string;
  siteUrl: string;
  contentDir: string;
  staticImagesDir: string;
  wpApiUrl: string;
  domain: string;
  domainRegex: string;
  mediaUrlRegex: RegExp;
  postRoute: RoutePatternConfig;
  verification: VerificationConfig;
  authorExport: AuthorExportConfig;
  customPostTypes: Array<{ type: string; section: string }>;
}

const DEFAULT_POST_ROUTE: RoutePatternConfig = {
  contentPath: "archives/:year/:month/:slug",
  urlPath: "/archives/:year/:month/:slug/",
};

const DEFAULT_VERIFICATION = {
  targets: ["posts"] as VerificationTarget[],
  sources: ["content"] as VerificationSource[],
  publicDir: "./public",
  categoryBasePath: "/category/",
  authorBasePath: "/author/",
};

const DEFAULT_AUTHOR_EXPORT = {
  enabled: false,
  frontMatterField: "author",
  dataFile: "data/authors.json",
};

const ALLOWED_VERIFICATION_TARGETS = new Set<VerificationTarget>([
  "posts",
  "pages",
  "categories",
  "authors",
]);

const ALLOWED_VERIFICATION_SOURCES = new Set<VerificationSource>([
  "content",
  "public",
]);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveConfigPath(configPath?: string): string {
  if (configPath) {
    return path.resolve(configPath);
  }
  if (process.env.WP_TO_HUGO_CONFIG) {
    return path.resolve(process.env.WP_TO_HUGO_CONFIG);
  }
  return path.resolve(process.cwd(), "wp-config.json");
}

function validateEnumList(
  values: unknown,
  allowedValues: Set<string>,
  label: string,
  invalidValueLabel: string,
): void {
  if (values === undefined) {
    return;
  }

  if (!Array.isArray(values)) {
    throw new Error(`${label} must be an array`);
  }

  for (const value of values) {
    if (typeof value !== "string" || !allowedValues.has(value)) {
      throw new Error(`Invalid ${invalidValueLabel}: ${String(value)}`);
    }
  }
}

export function loadConfig(configPath?: string): ResolvedConfig {
  const resolvedConfigPath = resolveConfigPath(configPath);

  if (!fs.existsSync(resolvedConfigPath)) {
    console.error(
      "Error: wp-config.json not found.\n" +
      "Copy wp-config.example.json to wp-config.json and edit it with your site details.\n" +
      `Expected at: ${resolvedConfigPath}`,
    );
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(resolvedConfigPath, "utf-8")) as WpToHugoConfig;

  if (!raw.siteUrl) {
    console.error("Error: siteUrl is required in wp-config.json");
    process.exit(1);
  }

  validateEnumList(
    raw.verification?.targets,
    ALLOWED_VERIFICATION_TARGETS,
    "verification.targets",
    "verification target",
  );
  validateEnumList(
    raw.verification?.sources,
    ALLOWED_VERIFICATION_SOURCES,
    "verification.sources",
    "verification source",
  );

  const configDir = path.dirname(resolvedConfigPath);
  const siteUrl = raw.siteUrl.replace(/\/+$/, "");
  const domain = siteUrl.replace(/^https?:\/\//, "");
  const domainRegex = escapeRegex(domain);
  const contentDir = path.resolve(configDir, raw.contentDir || "./content");
  const contentDirInput = raw.contentDir || "./content";
  const staticImagesDir = path.resolve(
    configDir,
    path.join(path.dirname(contentDirInput), "static/images"),
  );
  const postRoute: RoutePatternConfig = {
    contentPath: raw.postRoute?.contentPath || DEFAULT_POST_ROUTE.contentPath,
    urlPath: raw.postRoute?.urlPath || DEFAULT_POST_ROUTE.urlPath,
  };
  const verification: VerificationConfig = {
    targets: raw.verification?.targets || DEFAULT_VERIFICATION.targets,
    sources: raw.verification?.sources || DEFAULT_VERIFICATION.sources,
    publicDir: path.resolve(configDir, raw.verification?.publicDir || DEFAULT_VERIFICATION.publicDir),
    categoryBasePath: raw.verification?.categoryBasePath || DEFAULT_VERIFICATION.categoryBasePath,
    authorBasePath: raw.verification?.authorBasePath || DEFAULT_VERIFICATION.authorBasePath,
  };
  const authorExport: AuthorExportConfig = {
    enabled: raw.authorExport?.enabled ?? DEFAULT_AUTHOR_EXPORT.enabled,
    frontMatterField: raw.authorExport?.frontMatterField || DEFAULT_AUTHOR_EXPORT.frontMatterField,
    dataFile: path.resolve(configDir, raw.authorExport?.dataFile || DEFAULT_AUTHOR_EXPORT.dataFile),
  };

  assertSupportedRoutePattern(postRoute.contentPath, "postRoute.contentPath");
  assertSupportedRoutePattern(postRoute.urlPath, "postRoute.urlPath");
  assertCompatibleRoutePatterns(postRoute.contentPath, postRoute.urlPath);
  assertUniqueRoutePattern(postRoute.contentPath, "postRoute.contentPath");
  assertUniqueRoutePattern(postRoute.urlPath, "postRoute.urlPath");

  const mediaUrlRegex = new RegExp(
    `https?:\\/\\/(?:i\\d\\.wp\\.com\\/)?(?:www\\.)?${domainRegex}\\/wp-content\\/uploads\\/[^\\s)"']+`,
    "g",
  );

  return {
    configPath: resolvedConfigPath,
    configDir,
    siteUrl,
    contentDir,
    staticImagesDir,
    wpApiUrl: `${siteUrl}/wp-json/wp/v2`,
    domain,
    domainRegex,
    mediaUrlRegex,
    postRoute,
    verification,
    authorExport,
    customPostTypes: raw.customPostTypes || [],
  };
}
