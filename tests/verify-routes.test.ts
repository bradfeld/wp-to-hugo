import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../config";
import { runVerification } from "../wp-verify";
import { makeSitemap } from "./fixtures/sitemaps";
import { makeTempProject, writeJson } from "./helpers/temp-project";

test("wp-verify matches alternate blog urls against alternate blog content paths", async () => {
  const projectDir = makeTempProject();
  const configPath = path.join(projectDir, "wp-config.json");
  writeJson(configPath, {
    siteUrl: "https://example.com",
    postRoute: {
      contentPath: "posts/:year/:month/:day/:slug",
      urlPath: "/:year/:month/:day/:slug/",
    },
  });

  const contentFile = path.join(projectDir, "content", "posts", "2024", "03", "15", "hello-world", "index.md");
  fs.mkdirSync(path.dirname(contentFile), { recursive: true });
  fs.writeFileSync(contentFile, "---\ntitle: \"Hello\"\n---\n");

  const fetchMock: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/sitemap.xml")) {
      return new Response(makeSitemap(["https://example.com/2024/03/15/hello-world/"]), {
        status: 200,
        headers: { "Content-Type": "application/xml" },
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const result = await runVerification(loadConfig(configPath), { fetch: fetchMock });

  assert.equal(result.perfect, true);
  assert.equal(result.targets.posts.missing.length, 0);
  assert.equal(result.targets.posts.matched, 1);
});
