import assert from "node:assert/strict";
import test from "node:test";

import { buildPostRoutePlan, normalizeWordPressPostUrl } from "../routing";

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
