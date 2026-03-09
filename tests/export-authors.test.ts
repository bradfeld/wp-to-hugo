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

test("author export enriches posts and writes author data when users are available", async () => {
  const projectDir = makeTempProject();
  const configPath = path.join(projectDir, "wp-config.json");
  writeJson(configPath, {
    siteUrl: "https://example.com",
    authorExport: {
      enabled: true,
      frontMatterField: "author",
      dataFile: "data/authors.json",
    },
  });

  const post = makeFixturePost({ author: 12 });
  const category = makeFixtureCategory();
  const tag = makeFixtureTag();
  const staleAuthorDataFile = path.join(projectDir, "data", "authors.json");
  fs.mkdirSync(path.dirname(staleAuthorDataFile), { recursive: true });
  fs.writeFileSync(staleAuthorDataFile, JSON.stringify([{ slug: "stale-author" }], null, 2));

  const fetchMock: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/categories")) {
      return new Response(JSON.stringify([category]), { status: 200, headers: createHeaders(1, 1) });
    }
    if (url.includes("/tags")) {
      return new Response(JSON.stringify([tag]), { status: 200, headers: createHeaders(1, 1) });
    }
    if (url.includes("/users")) {
      return new Response(JSON.stringify([{ id: 12, slug: "jane-doe", name: "Jane Doe" }]), {
        status: 200,
        headers: createHeaders(1, 1),
      });
    }
    if (url.includes("/posts")) {
      return new Response(JSON.stringify([post]), { status: 200, headers: createHeaders(1, 1) });
    }
    if (url.includes("/pages")) {
      return new Response(JSON.stringify([]), { status: 200, headers: createHeaders(0, 0) });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await runExport(loadConfig(configPath), {
    fetch: fetchMock,
    stateFile: path.join(projectDir, ".export-state.json"),
  });

  const postFile = path.join(projectDir, "content", "archives", "2024", "03", "hello-world", "index.md");
  const authorDataFile = path.join(projectDir, "data", "authors.json");

  assert.match(fs.readFileSync(postFile, "utf-8"), /author: "jane-doe"/);
  assert.equal(fs.existsSync(authorDataFile), true);
  assert.equal(result.warnings.length, 0);
});

test("author export warns and continues when /users is unavailable", async () => {
  const projectDir = makeTempProject();
  const configPath = path.join(projectDir, "wp-config.json");
  writeJson(configPath, {
    siteUrl: "https://example.com",
    authorExport: {
      enabled: true,
      frontMatterField: "author",
      dataFile: "data/authors.json",
    },
  });

  const post = makeFixturePost({ author: 12 });
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
    if (url.includes("/users")) {
      return new Response(JSON.stringify({ code: "rest_user_invalid" }), {
        status: 404,
        headers: createHeaders(0, 0),
      });
    }
    if (url.includes("/posts")) {
      return new Response(JSON.stringify([post]), { status: 200, headers: createHeaders(1, 1) });
    }
    if (url.includes("/pages")) {
      return new Response(JSON.stringify([]), { status: 200, headers: createHeaders(0, 0) });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await runExport(loadConfig(configPath), {
    fetch: fetchMock,
    stateFile: path.join(projectDir, ".export-state.json"),
  });

  const postFile = path.join(projectDir, "content", "archives", "2024", "03", "hello-world", "index.md");

  assert.equal(result.warnings.length, 1);
  assert.equal(fs.readFileSync(postFile, "utf-8").includes("author:"), false);
  assert.equal(fs.existsSync(staleAuthorDataFile), false);
  assert.equal(result.state.phase, "complete");
});
