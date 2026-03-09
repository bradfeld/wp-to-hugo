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

test("verification surfaces ambiguity for overlapping root-level routes discovered only from public output", async () => {
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

  assert.equal(result.perfect, false);
  assert.equal(result.targets.posts.matched, 0);
  assert.equal(result.targets.pages.matched, 0);
  assert.equal(result.ambiguities.length, 1);
  assert.deepEqual(result.ambiguities[0]?.candidates, [
    { target: "posts", key: "about" },
    { target: "pages", key: "about" },
  ]);
});

test("verification counts nested pages and hierarchical categories instead of skipping them", async () => {
  const projectDir = makeTempProject();
  const configPath = path.join(projectDir, "wp-config.json");
  writeJson(configPath, {
    siteUrl: "https://example.com",
    verification: {
      targets: ["pages", "categories"],
      sources: ["content"],
      categoryBasePath: "/category/",
    },
  });

  writeFile(path.join(projectDir, "content", "company", "about.md"));
  writeFile(path.join(projectDir, "content", "_index.md"));
  writeFile(path.join(projectDir, "content", "categories", "parent", "child", "_index.md"));

  const fetchMock: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/sitemap.xml")) {
      return new Response(
        makeSitemap([
          "https://example.com/company/about/",
          "https://example.com/",
          "https://example.com/category/parent/child/",
        ]),
        { status: 200, headers: { "Content-Type": "application/xml" } },
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await runVerification(loadConfig(configPath), { fetch: fetchMock });

  assert.equal(result.perfect, true);
  assert.equal(result.targets.pages.matched, 2);
  assert.equal(result.targets.categories.matched, 1);
});

test("verification matches routes for siteUrl values served from a subpath", async () => {
  const projectDir = makeTempProject();
  const configPath = path.join(projectDir, "wp-config.json");
  writeJson(configPath, {
    siteUrl: "https://example.com/blog",
    verification: {
      targets: ["posts", "pages", "categories"],
      sources: ["content"],
      categoryBasePath: "/category/",
    },
  });

  writeFile(path.join(projectDir, "content", "archives", "2024", "03", "hello-world", "index.md"));
  writeFile(path.join(projectDir, "content", "company", "about.md"));
  writeFile(path.join(projectDir, "content", "categories", "essays", "_index.md"));

  const fetchMock: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/sitemap.xml")) {
      return new Response(
        makeSitemap([
          "https://example.com/blog/archives/2024/03/hello-world/",
          "https://example.com/blog/company/about/",
          "https://example.com/blog/category/essays/",
        ]),
        { status: 200, headers: { "Content-Type": "application/xml" } },
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await runVerification(loadConfig(configPath), { fetch: fetchMock });

  assert.equal(result.perfect, true);
  assert.equal(result.targets.posts.matched, 1);
  assert.equal(result.targets.pages.matched, 1);
  assert.equal(result.targets.categories.matched, 1);
});

test("verification accepts sitemap urls served from a www alias", async () => {
  const projectDir = makeTempProject();
  const configPath = path.join(projectDir, "wp-config.json");
  writeJson(configPath, {
    siteUrl: "https://example.com",
    verification: {
      targets: ["posts"],
      sources: ["content"],
    },
  });

  writeFile(path.join(projectDir, "content", "archives", "2024", "03", "hello-world", "index.md"));

  const fetchMock: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/sitemap.xml")) {
      return new Response(
        makeSitemap(["https://www.example.com/archives/2024/03/hello-world/"]),
        { status: 200, headers: { "Content-Type": "application/xml" } },
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await runVerification(loadConfig(configPath), { fetch: fetchMock });

  assert.equal(result.perfect, true);
  assert.equal(result.targets.posts.matched, 1);
  assert.equal(result.ambiguities.length, 0);
});
