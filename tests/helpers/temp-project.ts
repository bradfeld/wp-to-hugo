import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function makeTempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wp-to-hugo-"));
}

export function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}
