import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { applyContentTransform } from "../content-transform";
import { makeTempProject } from "./helpers/temp-project";

test("content stays unchanged when no transform is configured", async () => {
  const result = await applyContentTransform("hello", { kind: "post", slug: "hello-world" });
  assert.equal(result, "hello");
});

test("configured transform can rewrite markdown", async () => {
  const result = await applyContentTransform("hello", { kind: "post", slug: "hello-world" }, {
    modulePath: path.resolve("tests/fixtures/sample-transform.ts"),
  });

  assert.equal(result, "hello\n\nTransformed.");
});

test("invalid transform modules fail with a config error", async () => {
  const projectDir = makeTempProject();
  const modulePath = path.join(projectDir, "invalid-transform.js");
  fs.writeFileSync(modulePath, "export const nope = 1;\n");

  await assert.rejects(
    applyContentTransform("hello", { kind: "page", slug: "about" }, { modulePath }),
    /does not export a function/,
  );
});

test("throwing transforms include content context in the error", async () => {
  const projectDir = makeTempProject();
  const modulePath = path.join(projectDir, "throwing-transform.js");
  fs.writeFileSync(modulePath, "export default async function () { throw new Error('boom'); }\n");

  await assert.rejects(
    applyContentTransform("hello", { kind: "custom-post-type", slug: "book-one" }, { modulePath }),
    /custom-post-type.*book-one.*boom/,
  );
});
