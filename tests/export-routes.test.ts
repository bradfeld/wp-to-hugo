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

test("wp-export writes default archive bundle paths", async () => {
  const projectDir = makeTempProject();
  const configPath = path.join(projectDir, "wp-config.json");
  writeJson(configPath, { siteUrl: "https://example.com" });

  const post = makeFixturePost();
  const category = makeFixtureCategory();
  const tag = makeFixtureTag();

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
      return new Response(JSON.stringify([]), { status: 200, headers: createHeaders(0, 0) });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  await runExport(loadConfig(configPath), {
    fetch: fetchMock,
    stateFile: path.join(projectDir, ".export-state.json"),
  });

  assert.equal(
    fs.existsSync(path.join(projectDir, "content", "archives", "2024", "03", "hello-world", "index.md")),
    true,
  );
});

test("wp-export writes configured slug-only bundle paths", async () => {
  const projectDir = makeTempProject();
  const configPath = path.join(projectDir, "wp-config.json");
  writeJson(configPath, {
    siteUrl: "https://example.com",
    postRoute: {
      contentPath: "posts/:slug",
      urlPath: "/:slug/",
    },
  });

  const post = makeFixturePost();
  const category = makeFixtureCategory();
  const tag = makeFixtureTag();

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
      return new Response(JSON.stringify([]), { status: 200, headers: createHeaders(0, 0) });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  await runExport(loadConfig(configPath), {
    fetch: fetchMock,
    stateFile: path.join(projectDir, ".export-state.json"),
  });

  assert.equal(
    fs.existsSync(path.join(projectDir, "content", "posts", "hello-world", "index.md")),
    true,
  );
});
