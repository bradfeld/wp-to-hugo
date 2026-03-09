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

export type VerificationTarget = "posts" | "pages" | "categories";
export type VerificationSource = "content" | "public";

export interface VerificationConfig {
  targets: VerificationTarget[];
  sources: VerificationSource[];
  publicDir: string;
  categoryBasePath: string;
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
};

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
    customPostTypes: raw.customPostTypes || [],
  };
}
