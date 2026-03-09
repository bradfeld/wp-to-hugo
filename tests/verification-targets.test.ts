import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../config";
import {
  classifySitemapUrlCandidates,
  contentPathToKey,
  publicPathToKey,
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
