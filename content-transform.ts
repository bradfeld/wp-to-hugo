import { pathToFileURL } from "node:url";

export interface TransformContext {
  kind: "post" | "page" | "custom-post-type";
  slug: string;
  sourceUrl?: string;
}

export type ContentTransform = (
  markdown: string,
  context: TransformContext,
) => string | Promise<string>;

export async function applyContentTransform(
  markdown: string,
  context: TransformContext,
  config?: { modulePath?: string; exportName?: string },
): Promise<string> {
  if (!config?.modulePath) {
    return markdown;
  }

  const loaded = await import(pathToFileURL(config.modulePath).href);
  const exportName = config.exportName || "default";
  const candidate = loaded[exportName];

  if (typeof candidate !== "function") {
    throw new Error(`Content transform module ${config.modulePath} does not export a function named ${exportName}`);
  }

  try {
    return await (candidate as ContentTransform)(markdown, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Content transform failed for ${context.kind} ${context.slug}: ${message}`);
  }
}
