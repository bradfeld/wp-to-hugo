import fs from "node:fs";
import path from "node:path";

import { type AuthorExportConfig, type ResolvedConfig } from "./config";

export interface WPUser {
  id: number;
  slug: string;
  name: string;
}

export interface AuthorInfo {
  id: number;
  slug: string;
  name: string;
}

export interface AuthorExportState {
  authorMap: Map<number, AuthorInfo>;
  enabledForRun: boolean;
}

function escapeYamlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function buildAuthorMap(users: WPUser[]): Map<number, AuthorInfo> {
  const sortedUsers = [...users].sort((left, right) => left.slug.localeCompare(right.slug));
  return new Map(sortedUsers.map((user) => [user.id, { id: user.id, slug: user.slug, name: user.name }]));
}

export function buildAuthorDataPayload(authorMap: Map<number, AuthorInfo>): AuthorInfo[] {
  return [...authorMap.values()].sort((left, right) => left.slug.localeCompare(right.slug));
}

export function appendAuthorFrontMatter(
  frontMatter: string,
  authorSlug: string | undefined,
  config: AuthorExportConfig,
): string {
  if (!config.enabled || !authorSlug) {
    return frontMatter;
  }

  const closingMarker = frontMatter.lastIndexOf("---");
  if (closingMarker <= 0) {
    return `${frontMatter}${config.frontMatterField}: ${escapeYamlString(authorSlug)}\n`;
  }

  return (
    `${frontMatter.slice(0, closingMarker)}${config.frontMatterField}: ${escapeYamlString(authorSlug)}\n` +
    frontMatter.slice(closingMarker)
  );
}

async function fetchAllUsers(fetchImpl: typeof fetch, wpApiUrl: string): Promise<WPUser[]> {
  const users: WPUser[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const url = `${wpApiUrl}/users?per_page=100&page=${page}`;
    const response = await fetchImpl(url);
    if (!response.ok) {
      throw new Error(`API error ${response.status}: ${url}`);
    }
    const data = await response.json() as WPUser[];
    users.push(...data);
    totalPages = parseInt(response.headers.get("X-WP-TotalPages") || "0", 10) || 1;
    page += 1;
  } while (page <= totalPages);

  return users;
}

export async function loadAuthorExportState(
  config: ResolvedConfig,
  fetchImpl: typeof fetch,
  warn: (message: string) => void,
): Promise<AuthorExportState> {
  if (!config.authorExport.enabled) {
    return { authorMap: new Map(), enabledForRun: false };
  }

  try {
    const users = await fetchAllUsers(fetchImpl, config.wpApiUrl);
    return {
      authorMap: buildAuthorMap(users),
      enabledForRun: true,
    };
  } catch (error) {
    warn(`Author export disabled for this run: ${error instanceof Error ? error.message : String(error)}`);
    return {
      authorMap: new Map(),
      enabledForRun: false,
    };
  }
}

export function writeAuthorDataFile(filePath: string, authorMap: Map<number, AuthorInfo>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(buildAuthorDataPayload(authorMap), null, 2));
}

export function removeAuthorDataFile(filePath: string): void {
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath);
  }
}
