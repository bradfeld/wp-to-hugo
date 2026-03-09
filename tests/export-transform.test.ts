import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../config";
import { runExport } from "../wp-export";
import { makeFixtureCategory, makeFixturePost, makeFixtureTag } from "./fixtures/wordpress";
import { makeTempProject, writeJson } from "./helpers/temp-project";

function createHeaders(total: number, totalPages: number): Headers {
  return new Headers({
    "X-WP-Total": String(total),
    "X-WP-TotalPages": String(totalPages),
  });
}

test("configured transforms rewrite posts, pages, and custom post types in wp-export", async () => {
  const projectDir = makeTempProject();
  const configPath = path.join(projectDir, "wp-config.json");
  writeJson(configPath, {
    siteUrl: "https://example.com",
    contentTransform: {
      module: path.resolve("tests/fixtures/sample-transform.ts"),
    },
    customPostTypes: [{ type: "book", section: "books" }],
  });

  const post = makeFixturePost();
  const page = makeFixturePost({
    id: 43,
    slug: "about",
    title: { rendered: "About" },
    link: "https://example.com/about/",
  });
  const customPost = makeFixturePost({ id: 44, slug: "book-one", title: { rendered: "Book One" } });
  const category = makeFixtureCategory();
  const tag = makeFixtureTag();
  const writerCallsites: string[] = [];

  const fetchMock: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/categories")) {
      return new Response(JSON.stringify([category]), { status: 200, headers: createHeaders(1, 1) });
    }
    if (url.includes("/tags")) {
      return new Response(JSON.stringify([tag]), { status: 200, headers: createHeaders(1, 1) });
    }
    if (url.includes("/posts")) {
      return new Response(JSON.stringify([post]), { status: 200, headers: createHeaders(1, 1) });
    }
    if (url.includes("/pages")) {
      return new Response(JSON.stringify([page]), { status: 200, headers: createHeaders(1, 1) });
    }
    if (url.includes("/book")) {
      return new Response(JSON.stringify([customPost]), { status: 200, headers: createHeaders(1, 1) });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  await runExport(loadConfig(configPath), {
    fetch: fetchMock,
    stateFile: path.join(projectDir, ".export-state.json"),
    writerRecorder: (callsite) => writerCallsites.push(callsite),
  });

  assert.match(
    fs.readFileSync(path.join(projectDir, "content", "archives", "2024", "03", "hello-world", "index.md"), "utf-8"),
    /Transformed\./,
  );
  assert.match(fs.readFileSync(path.join(projectDir, "content", "about.md"), "utf-8"), /Transformed\./);
  assert.match(
    fs.readFileSync(path.join(projectDir, "content", "books", "book-one", "index.md"), "utf-8"),
    /Transformed\./,
  );
  assert.deepEqual(writerCallsites.sort(), [
    "wp-export.ts:custom-post-type",
    "wp-export.ts:page",
    "wp-export.ts:post",
  ]);
});
