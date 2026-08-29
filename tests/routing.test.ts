import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../config";
import { buildPostRoutePlan, normalizeWordPressPostUrl } from "../routing";
import { makeTempProject, writeJson } from "./helpers/temp-project";

test("default route stays archive based", () => {
  const plan = buildPostRoutePlan(
    { id: 42, date: "2024-03-15T10:00:00", slug: "hello-world" },
    { contentPath: "archives/:year/:month/:slug", urlPath: "/archives/:year/:month/:slug/" },
  );

  assert.equal(plan.bundleDir, "archives/2024/03/hello-world");
  assert.equal(plan.indexFile, "archives/2024/03/hello-world/index.md");
  assert.equal(plan.publicUrl, "/archives/2024/03/hello-world/");
  assert.equal(plan.key, "archives/2024/03/hello-world");
});

test("slug-only route is rendered from config", () => {
  const plan = buildPostRoutePlan(
    { id: 42, date: "2024-03-15T10:00:00", slug: "hello-world" },
    { contentPath: "posts/:slug", urlPath: "/:slug/" },
  );

  assert.equal(plan.indexFile, "posts/hello-world/index.md");
  assert.equal(plan.publicUrl, "/hello-world/");
  assert.equal(plan.key, "hello-world");
});

test("day-dated route is rendered from config", () => {
  const plan = buildPostRoutePlan(
    { id: 42, date: "2024-03-15T10:00:00", slug: "hello-world" },
    { contentPath: "posts/:year/:month/:day/:slug", urlPath: "/:year/:month/:day/:slug/" },
  );

  assert.equal(plan.publicUrl, "/2024/03/15/hello-world/");
  assert.equal(plan.key, "2024/03/15/hello-world");
});

test("wordPress urls normalize through the configured url pattern", () => {
  assert.equal(
    normalizeWordPressPostUrl(
      "https://example.com/2024/03/15/hello-world/",
      "/:year/:month/:day/:slug/",
    ),
    "2024/03/15/hello-world",
  );
});

test("wordPress urls normalize relative to a siteUrl subpath", () => {
  assert.equal(
    normalizeWordPressPostUrl(
      "https://example.com/blog/archives/2024/03/hello-world/",
      "/archives/:year/:month/:slug/",
      "https://example.com/blog",
    ),
    "archives/2024/03/hello-world",
  );
});

test("wordPress urls normalize across www aliases", () => {
  assert.equal(
    normalizeWordPressPostUrl(
      "https://www.example.com/archives/2024/03/hello-world/",
      "/archives/:year/:month/:slug/",
      "https://example.com",
    ),
    "archives/2024/03/hello-world",
  );
  assert.equal(
    normalizeWordPressPostUrl(
      "https://example.com/archives/2024/03/hello-world/",
      "/archives/:year/:month/:slug/",
      "https://www.example.com",
    ),
    "archives/2024/03/hello-world",
  );
});

test("config rejects url route tokens that are missing from contentPath", () => {
  const projectDir = makeTempProject();
  const configPath = path.join(projectDir, "wp-config.json");
  writeJson(configPath, {
    siteUrl: "https://example.com",
    postRoute: {
      contentPath: "posts/:slug",
      urlPath: "/:year/:slug/",
    },
  });

  assert.throws(
    () => loadConfig(configPath),
    /postRoute\.urlPath uses tokens not present in postRoute\.contentPath: :year/,
  );
});

test("config rejects post routes that are not unique per post", () => {
  const projectDir = makeTempProject();

  const invalidContentPath = path.join(projectDir, "wp-config-invalid-content-route.json");
  writeJson(invalidContentPath, {
    siteUrl: "https://example.com",
    postRoute: {
      contentPath: "posts/:year/:month",
      urlPath: "/:year/:month/",
    },
  });

  assert.throws(
    () => loadConfig(invalidContentPath),
    /postRoute\.contentPath must include at least one unique token \(:slug or :id\)/,
  );

  const invalidUrlPath = path.join(projectDir, "wp-config-invalid-url-route.json");
  writeJson(invalidUrlPath, {
    siteUrl: "https://example.com",
    postRoute: {
      contentPath: "posts/:year/:month/:id",
      urlPath: "/:year/:month/",
    },
  });

  assert.throws(
    () => loadConfig(invalidUrlPath),
    /postRoute\.urlPath must include at least one unique token \(:slug or :id\)/,
  );
});
