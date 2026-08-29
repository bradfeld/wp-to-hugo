export default async function sampleTransform(markdown: string): Promise<string> {
  return `${markdown}\n\nTransformed.`;
}
