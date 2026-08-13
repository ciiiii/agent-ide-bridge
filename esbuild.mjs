import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: true,
  minify: false,
  logLevel: "info",
};

/** VS Code extension bundle. @type {import('esbuild').BuildOptions} */
const extension = {
  ...common,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  external: ["vscode"], // provided by the extension host
};

/** Standalone terminal diff CLI. @type {import('esbuild').BuildOptions} */
const cli = {
  ...common,
  entryPoints: ["src/cli/index.ts"],
  outfile: "dist/cli.js",
  banner: { js: "#!/usr/bin/env node" },
};

if (watch) {
  for (const opts of [extension, cli]) {
    const ctx = await esbuild.context(opts);
    await ctx.watch();
  }
  console.log("[esbuild] watching…");
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(cli)]);
}
