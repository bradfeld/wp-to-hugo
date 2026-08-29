import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../config";
import { runCustomTypeExport } from "../export-custom-types";
import { runExport } from "../wp-export";
import { makeFixturePost } from "./fixtures/wordpress";
import { makeTempProject, writeJson } from "./helpers/temp-project";

function createHeaders(total: number, totalPages: number): Headers {
  return new Headers({
    "X-WP-Total": String(total),
    "X-WP-TotalPages": String(totalPages),
  });
}

test("configured transforms rewrite custom post types in export-custom-types", async () => {
  const projectDir = makeTempProject();
  const configPath = path.join(projectDir, "wp-config.json");
  writeJson(configPath, {
    siteUrl: "https://example.com",
    contentTransform: {
      module: path.resolve("tests/fixtures/sample-transform.ts"),
    },
    customPostTypes: [{ type: "book", section: "books" }],
  });

  const post = makeFixturePost({ slug: "book-one", title: { rendered: "Book One" } });
  const writerCallsites: string[] = [];

  const fetchMock: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/book")) {
      return new Response(JSON.stringify([post]), { status: 200, headers: createHeaders(1, 1) });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  await runCustomTypeExport(loadConfig(configPath), {
    fetch: fetchMock,
    writerRecorder: (callsite) => writerCallsites.push(callsite),
  });

  assert.match(
    fs.readFileSync(path.join(projectDir, "content", "books", "book-one", "index.md"), "utf-8"),
    /Transformed\./,
  );
  assert.deepEqual(writerCallsites, ["export-custom-types.ts:custom-post-type"]);
});

test("all export entrypoints use the shared transform-enabled writer", async () => {
  const projectDir = makeTempProject();
  const configPath = path.join(projectDir, "wp-config.json");
  writeJson(configPath, {
    siteUrl: "https://example.com",
    contentTransform: {
      module: path.resolve("tests/fixtures/sample-transform.ts"),
    },
    customPostTypes: [{ type: "book", section: "books" }],
  });

  const writerCallsites: string[] = [];
  const post = makeFixturePost();
  const page = makeFixturePost({ id: 43, slug: "about", title: { rendered: "About" } });
  const customPost = makeFixturePost({ id: 44, slug: "book-one", title: { rendered: "Book One" } });

  const exportFetchMock: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/categories")) {
      return new Response(JSON.stringify([]), { status: 200, headers: createHeaders(0, 0) });
    }
    if (url.includes("/tags")) {
      return new Response(JSON.stringify([]), { status: 200, headers: createHeaders(0, 0) });
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

  const customFetchMock: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/book")) {
      return new Response(JSON.stringify([customPost]), { status: 200, headers: createHeaders(1, 1) });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  await runExport(loadConfig(configPath), {
    fetch: exportFetchMock,
    stateFile: path.join(projectDir, ".export-state.json"),
    writerRecorder: (callsite) => writerCallsites.push(callsite),
  });

  await runCustomTypeExport(loadConfig(configPath), {
    fetch: customFetchMock,
    writerRecorder: (callsite) => writerCallsites.push(callsite),
  });

  assert.deepEqual(writerCallsites.sort(), [
    "export-custom-types.ts:custom-post-type",
    "wp-export.ts:custom-post-type",
    "wp-export.ts:page",
    "wp-export.ts:post",
  ]);
});
