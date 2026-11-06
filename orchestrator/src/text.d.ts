// Markdown files bundled as text by the wrangler rule in wrangler.jsonc.
declare module "*.md" {
  const text: string;
  export default text;
}
