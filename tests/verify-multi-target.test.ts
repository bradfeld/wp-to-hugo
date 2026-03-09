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

test("verification matches configured target types from content-only, public-only, and union discovery", async () => {
  const sitemap = makeSitemap([
    "https://example.com/archives/2024/03/hello-world/",
    "https://example.com/about/",
    "https://example.com/category/essays/",
  ]);

  const fetchMock: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/sitemap.xml")) {
      return new Response(sitemap, { status: 200, headers: { "Content-Type": "application/xml" } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  for (const sources of [["content"], ["public"], ["content", "public"]] as const) {
    const projectDir = makeTempProject();
    const configPath = path.join(projectDir, "wp-config.json");
    writeJson(configPath, {
      siteUrl: "https://example.com",
      verification: {
        targets: ["posts", "pages", "categories"],
        sources,
      },
    });

    if (sources.includes("content")) {
      writeFile(path.join(projectDir, "content", "archives", "2024", "03", "hello-world", "index.md"));
      writeFile(path.join(projectDir, "content", "about.md"));
      writeFile(path.join(projectDir, "content", "categories", "essays", "_index.md"));
    }

    if (sources.includes("public")) {
      writeFile(path.join(projectDir, "public", "archives", "2024", "03", "hello-world", "index.html"));
      writeFile(path.join(projectDir, "public", "about", "index.html"));
      writeFile(path.join(projectDir, "public", "category", "essays", "index.html"));
    }

    const result = await runVerification(loadConfig(configPath), { fetch: fetchMock });

    assert.equal(result.perfect, true);
    assert.equal(result.targets.posts.matched, 1);
    assert.equal(result.targets.pages.matched, 1);
    assert.equal(result.targets.categories.matched, 1);
    assert.equal(result.ambiguities.length, 0);
  }
});

test("verification resolves overlapping root-level routes against discovered public outputs", async () => {
  const projectDir = makeTempProject();
  const configPath = path.join(projectDir, "wp-config.json");
  writeJson(configPath, {
    siteUrl: "https://example.com",
    postRoute: {
      contentPath: "posts/:slug",
      urlPath: "/:slug/",
    },
    verification: {
      targets: ["posts", "pages"],
      sources: ["public"],
    },
  });

  writeFile(path.join(projectDir, "public", "about", "index.html"));

  const fetchMock: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/sitemap.xml")) {
      return new Response(makeSitemap(["https://example.com/about/"]), {
        status: 200,
        headers: { "Content-Type": "application/xml" },
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await runVerification(loadConfig(configPath), { fetch: fetchMock });

  assert.equal(result.perfect, true);
  assert.equal(result.targets.posts.matched, 0);
  assert.equal(result.targets.pages.matched, 1);
  assert.equal(result.ambiguities.length, 0);
});
