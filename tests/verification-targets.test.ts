import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../config";
import {
  classifySitemapUrlCandidates,
  contentPathToKey,
  publicPathToKey,
  publicPathToMatches,
  resolveVerificationMatches,
} from "../verification-targets";
import { makeTempProject, writeJson } from "./helpers/temp-project";

test("verification classifies configured target types", () => {
  const projectDir = makeTempProject();
  const configPath = path.join(projectDir, "wp-config.json");
  writeJson(configPath, {
    siteUrl: "https://example.com",
    postRoute: {
      contentPath: "posts/:slug",
      urlPath: "/:slug/",
    },
    verification: {
      targets: ["posts", "pages", "categories"],
      sources: ["content"],
      categoryBasePath: "/category/",
    },
  });

  const config = loadConfig(configPath);

  assert.deepEqual(
    classifySitemapUrlCandidates("https://example.com/category/essays/", config),
    [{ target: "categories", key: "essays" }],
  );
});

test("verification resolves ambiguous root-level routes against discovered Hugo outputs", () => {
  const projectDir = makeTempProject();
  const configPath = path.join(projectDir, "wp-config.json");
  writeJson(configPath, {
    siteUrl: "https://example.com",
    postRoute: {
      contentPath: "posts/:slug",
      urlPath: "/:slug/",
    },
    verification: {
      targets: ["posts", "pages", "categories"],
      sources: ["content"],
    },
  });

  const config = loadConfig(configPath);
  const candidates = classifySitemapUrlCandidates("https://example.com/about/", config);

  assert.deepEqual(candidates, [
    { target: "posts", key: "about" },
    { target: "pages", key: "about" },
  ]);

  const resolved = resolveVerificationMatches(candidates, {
    posts: new Set<string>(),
    pages: new Set<string>(["about"]),
    categories: new Set<string>(),
  });

  assert.deepEqual(resolved, [{ target: "pages", key: "about" }]);
});

test("verification discovers content and public keys for configured targets", () => {
  const projectDir = makeTempProject();
  const configPath = path.join(projectDir, "wp-config.json");
  writeJson(configPath, {
    siteUrl: "https://example.com",
    postRoute: {
      contentPath: "posts/:slug",
      urlPath: "/:slug/",
    },
    verification: {
      targets: ["posts", "pages", "categories"],
      sources: ["content", "public"],
    },
  });

  const config = loadConfig(configPath);

  assert.deepEqual(
    contentPathToKey(
      path.join(projectDir, "content", "posts", "hello-world", "index.md"),
      config.contentDir,
      config,
    ),
    { target: "posts", key: "hello-world" },
  );

  assert.deepEqual(
    publicPathToKey(
      path.join(projectDir, "public", "category", "essays", "index.html"),
      config.verification.publicDir,
      config,
    ),
    { target: "categories", key: "essays" },
  );
});

test("verification supports nested pages and the homepage", () => {
  const projectDir = makeTempProject();
  const configPath = path.join(projectDir, "wp-config.json");
  writeJson(configPath, {
    siteUrl: "https://example.com",
    verification: {
      targets: ["pages"],
      sources: ["content", "public"],
    },
  });

  const config = loadConfig(configPath);

  assert.deepEqual(
    classifySitemapUrlCandidates("https://example.com/company/about/", config),
    [{ target: "pages", key: "company/about" }],
  );
  assert.deepEqual(
    classifySitemapUrlCandidates("https://example.com/", config),
    [{ target: "pages", key: "" }],
  );
  assert.deepEqual(
    contentPathToKey(
      path.join(projectDir, "content", "company", "about.md"),
      config.contentDir,
      config,
    ),
    { target: "pages", key: "company/about" },
  );
  assert.deepEqual(
    contentPathToKey(
      path.join(projectDir, "content", "_index.md"),
      config.contentDir,
      config,
    ),
    { target: "pages", key: "" },
  );
  assert.deepEqual(
    publicPathToKey(
      path.join(projectDir, "public", "company", "about", "index.html"),
      config.verification.publicDir,
      config,
    ),
    { target: "pages", key: "company/about" },
  );
  assert.deepEqual(
    publicPathToKey(
      path.join(projectDir, "public", "index.html"),
      config.verification.publicDir,
      config,
    ),
    { target: "pages", key: "" },
  );
});

test("verification supports hierarchical category routes", () => {
  const projectDir = makeTempProject();
  const configPath = path.join(projectDir, "wp-config.json");
  writeJson(configPath, {
    siteUrl: "https://example.com",
    verification: {
      targets: ["categories"],
      sources: ["content", "public"],
      categoryBasePath: "/category/",
    },
  });

  const config = loadConfig(configPath);

  assert.deepEqual(
    classifySitemapUrlCandidates("https://example.com/category/parent/child/", config),
    [{ target: "categories", key: "parent/child" }],
  );
  assert.deepEqual(
    contentPathToKey(
      path.join(projectDir, "content", "categories", "parent", "child", "_index.md"),
      config.contentDir,
      config,
    ),
    { target: "categories", key: "parent/child" },
  );
  assert.deepEqual(
    publicPathToKey(
      path.join(projectDir, "public", "category", "parent", "child", "index.html"),
      config.verification.publicDir,
      config,
    ),
    { target: "categories", key: "parent/child" },
  );
});

test("verification strips a siteUrl subpath before classifying routes", () => {
  const projectDir = makeTempProject();
  const configPath = path.join(projectDir, "wp-config.json");
  writeJson(configPath, {
    siteUrl: "https://example.com/blog",
    verification: {
      targets: ["posts", "pages", "categories"],
      sources: ["content", "public"],
      categoryBasePath: "/category/",
    },
  });

  const config = loadConfig(configPath);

  assert.deepEqual(
    classifySitemapUrlCandidates("https://example.com/blog/archives/2024/03/hello-world/", config),
    [{ target: "posts", key: "archives/2024/03/hello-world" }],
  );
  assert.deepEqual(
    classifySitemapUrlCandidates("https://example.com/blog/category/essays/", config),
    [{ target: "categories", key: "essays" }],
  );
  assert.deepEqual(
    classifySitemapUrlCandidates("https://example.com/blog/company/about/", config),
    [{ target: "pages", key: "company/about" }],
  );
  assert.deepEqual(
    publicPathToKey(
      path.join(projectDir, "public", "archives", "2024", "03", "hello-world", "index.html"),
      config.verification.publicDir,
      config,
    ),
    { target: "posts", key: "archives/2024/03/hello-world" },
  );
});

test("verification accepts www aliases when classifying sitemap routes", () => {
  const projectDir = makeTempProject();
  const configPath = path.join(projectDir, "wp-config.json");
  writeJson(configPath, {
    siteUrl: "https://example.com",
    verification: {
      targets: ["posts", "pages", "categories"],
      sources: ["content"],
      categoryBasePath: "/category/",
    },
  });

  const config = loadConfig(configPath);

  assert.deepEqual(
    classifySitemapUrlCandidates("https://www.example.com/archives/2024/03/hello-world/", config),
    [{ target: "posts", key: "archives/2024/03/hello-world" }],
  );
  assert.deepEqual(
    classifySitemapUrlCandidates("https://www.example.com/category/essays/", config),
    [{ target: "categories", key: "essays" }],
  );
});

test("verification does not classify configured custom post type routes as pages", () => {
  const projectDir = makeTempProject();
  const configPath = path.join(projectDir, "wp-config.json");
  writeJson(configPath, {
    siteUrl: "https://example.com",
    customPostTypes: [{ type: "book", section: "books" }],
    verification: {
      targets: ["pages"],
      sources: ["content", "public"],
    },
  });

  const config = loadConfig(configPath);

  assert.deepEqual(
    classifySitemapUrlCandidates("https://example.com/books/book-one/", config),
    [],
  );
  assert.equal(
    contentPathToKey(
      path.join(projectDir, "content", "books", "book-one", "index.md"),
      config.contentDir,
      config,
    ),
    null,
  );
  assert.equal(
    publicPathToKey(
      path.join(projectDir, "public", "books", "book-one", "index.html"),
      config.verification.publicDir,
      config,
    ),
    null,
  );
});

test("page-only verification does not classify post-shaped urls as pages", () => {
  const projectDir = makeTempProject();
  const configPath = path.join(projectDir, "wp-config.json");
  writeJson(configPath, {
    siteUrl: "https://example.com",
    verification: {
      targets: ["pages"],
      sources: ["content"],
    },
  });

  const config = loadConfig(configPath);

  assert.deepEqual(
    classifySitemapUrlCandidates("https://example.com/archives/2024/03/hello-world/", config),
    [],
  );
  assert.equal(
    publicPathToKey(
      path.join(projectDir, "public", "archives", "2024", "03", "hello-world", "index.html"),
      config.verification.publicDir,
      config,
    ),
    null,
  );
});

test("public discovery preserves ambiguous slug-only routes as overlapping matches", () => {
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

  const config = loadConfig(configPath);
  const publicFile = path.join(projectDir, "public", "hello-world", "index.html");

  assert.deepEqual(
    publicPathToMatches(publicFile, config.verification.publicDir, config),
    [
      { target: "posts", key: "hello-world" },
      { target: "pages", key: "hello-world" },
    ],
  );
  assert.equal(
    publicPathToKey(publicFile, config.verification.publicDir, config),
    null,
  );
});

test("config rejects invalid verification targets and sources", () => {
  const projectDir = makeTempProject();

  const invalidTargetPath = path.join(projectDir, "wp-config-invalid-target.json");
  writeJson(invalidTargetPath, {
    siteUrl: "https://example.com",
    verification: {
      targets: ["page"],
      sources: ["content"],
    },
  });

  assert.throws(
    () => loadConfig(invalidTargetPath),
    /Invalid verification target: page/,
  );

  const invalidSourcePath = path.join(projectDir, "wp-config-invalid-source.json");
  writeJson(invalidSourcePath, {
    siteUrl: "https://example.com",
    verification: {
      targets: ["pages"],
      sources: ["contents"],
    },
  });

  assert.throws(
    () => loadConfig(invalidSourcePath),
    /Invalid verification source: contents/,
  );
});
