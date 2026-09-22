import { mkdir, rm, writeFile } from "node:fs/promises"
import { build } from "esbuild"

await rm("lib", { recursive: true, force: true })
await mkdir("lib/web", { recursive: true })
await build({
  entryPoints: ["src/index.ts"],
  outfile: "lib/index.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "external",
  sourcemap: true,
})
await build({
  entryPoints: ["src/server/standalone.ts"],
  outfile: "lib/server.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  packages: "external",
  sourcemap: true,
})
const result = await build({
  entryPoints: ["src/client.tsx"],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  external: ["@deepseek-ai/dsh-client-ui-primitives", "react", "react/jsx-runtime", "react-dom", "react-dom/client"],
  write: false,
})
await writeFile(
  "lib/client.js",
  `window.__ModuleLoader__.load({id:"dsh-decision-room",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${result.outputFiles[0].text}\nreturn module.exports;}});\n`,
)
await build({
  entryPoints: ["src/ui/main.tsx"],
  outfile: "lib/web/app.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
})
await writeFile(
  "lib/web/index.html",
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>决策室 · DSH 多模型评审</title><link rel="stylesheet" href="/decision-room/app.css"></head><body><div id="root"></div><script type="module" src="/decision-room/app.js"></script></body></html>',
)
