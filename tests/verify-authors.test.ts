import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../config";
import { runVerification } from "../wp-verify";
import { makeSitemap } from "./fixtures/sitemaps";
import { makeTempProject, writeJson } from "./helpers/temp-project";

function writeFile(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "test");
}

test("author verification matches content-owned author indexes", async () => {
  const projectDir = makeTempProject();
  const configPath = path.join(projectDir, "wp-config.json");
  writeJson(configPath, {
    siteUrl: "https://example.com",
    verification: {
      targets: ["authors"],
      sources: ["content"],
      authorBasePath: "/author/",
    },
  });

  writeFile(path.join(projectDir, "content", "authors", "jane-doe", "_index.md"));

  const fetchMock: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/sitemap.xml")) {
      return new Response(makeSitemap(["https://example.com/author/jane-doe/"]), {
        status: 200,
        headers: { "Content-Type": "application/xml" },
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await runVerification(loadConfig(configPath), { fetch: fetchMock });

  assert.equal(result.perfect, true);
  assert.equal(result.targets.authors.matched, 1);
});

test("author verification matches public author routes", async () => {
  const projectDir = makeTempProject();
  const configPath = path.join(projectDir, "wp-config.json");
  writeJson(configPath, {
    siteUrl: "https://example.com",
    verification: {
      targets: ["authors"],
      sources: ["public"],
      publicDir: "./public",
      authorBasePath: "/author/",
    },
  });

  writeFile(path.join(projectDir, "public", "author", "jane-doe", "index.html"));

  const fetchMock: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/sitemap.xml")) {
      return new Response(makeSitemap(["https://example.com/author/jane-doe/"]), {
        status: 200,
        headers: { "Content-Type": "application/xml" },
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await runVerification(loadConfig(configPath), { fetch: fetchMock });

  assert.equal(result.perfect, true);
  assert.equal(result.targets.authors.matched, 1);
});
