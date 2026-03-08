// config.ts — Shared configuration for all wp-to-hugo scripts
import fs from "node:fs";
import path from "node:path";

// --- Types ---

interface WpToHugoConfig {
  siteUrl: string;
  contentDir?: string;
  customPostTypes?: Array<{ type: string; section: string }>;
}

export interface ResolvedConfig {
  siteUrl: string;
  contentDir: string;
  staticImagesDir: string;
  wpApiUrl: string;
  domain: string;
  domainRegex: string;
  mediaUrlRegex: RegExp;
  customPostTypes: Array<{ type: string; section: string }>;
}

// --- Loader ---

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function loadConfig(): ResolvedConfig {
  const configPath = path.resolve(__dirname, "wp-config.json");

  if (!fs.existsSync(configPath)) {
    console.error(
      "Error: wp-config.json not found.\n" +
      "Copy wp-config.example.json to wp-config.json and edit it with your site details.\n" +
      `Expected at: ${configPath}`
    );
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(configPath, "utf-8")) as WpToHugoConfig;

  if (!raw.siteUrl) {
    console.error("Error: siteUrl is required in wp-config.json");
    process.exit(1);
  }

  // Strip trailing slash from siteUrl
  const siteUrl = raw.siteUrl.replace(/\/+$/, "");

  // Extract domain (strip protocol)
  const domain = siteUrl.replace(/^https?:\/\//, "");
  const domainRegex = escapeRegex(domain);

  // Content directory (resolve relative to config file location)
  const contentDir = path.resolve(
    path.dirname(configPath),
    raw.contentDir || "./content"
  );

  const staticImagesDir = path.resolve(
    path.dirname(configPath),
    raw.contentDir ? path.join(path.dirname(raw.contentDir), "static/images") : "./static/images"
  );

  // Build media URL regex that matches all WordPress CDN URL variants:
  //   https://i0.wp.com/{domain}/wp-content/uploads/...
  //   https://i0.wp.com/www.{domain}/wp-content/uploads/...
  //   https://{domain}/wp-content/uploads/...
  //   https://www.{domain}/wp-content/uploads/...
  const mediaUrlRegex = new RegExp(
    `https?:\\/\\/(?:i\\d\\.wp\\.com\\/)?(?:www\\.)?${domainRegex}\\/wp-content\\/uploads\\/[^\\s)"']+`,
    "g"
  );

  return {
    siteUrl,
    contentDir,
    staticImagesDir,
    wpApiUrl: `${siteUrl}/wp-json/wp/v2`,
    domain,
    domainRegex,
    mediaUrlRegex,
    customPostTypes: raw.customPostTypes || [],
  };
}
