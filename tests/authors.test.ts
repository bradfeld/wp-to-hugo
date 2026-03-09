import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { appendAuthorFrontMatter, buildAuthorDataPayload, buildAuthorMap } from "../authors";
import { loadConfig } from "../config";
import { makeTempProject, writeJson } from "./helpers/temp-project";

test("author export is a no-op when disabled", () => {
  const fm = appendAuthorFrontMatter("---\ntitle: \"Hello\"\n---\n", undefined, {
    enabled: false,
    frontMatterField: "author",
    dataFile: "data/authors.json",
  });

  assert.equal(fm.includes("author:"), false);
});

test("author export writes the configured front matter field", () => {
  const fm = appendAuthorFrontMatter("---\ntitle: \"Hello\"\n---\n", "jane-doe", {
    enabled: true,
    frontMatterField: "author",
    dataFile: "data/authors.json",
  });

  assert.match(fm, /author: "jane-doe"/);
});

test("author data output is stable regardless of source order", () => {
  const first = buildAuthorDataPayload(buildAuthorMap([
    { id: 2, slug: "zoe", name: "Zoe" },
    { id: 1, slug: "jane-doe", name: "Jane Doe" },
  ]));
  const second = buildAuthorDataPayload(buildAuthorMap([
    { id: 1, slug: "jane-doe", name: "Jane Doe" },
    { id: 2, slug: "zoe", name: "Zoe" },
  ]));

  assert.deepEqual(first, second);
});

test("author verification uses the configured author base path", () => {
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

  const config = loadConfig(configPath);
  assert.equal(config.verification.authorBasePath, "/author/");
});
