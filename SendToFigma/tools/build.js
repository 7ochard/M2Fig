const path = require("node:path");
const esbuild = require("esbuild");

const options = {
  absWorkingDir: path.resolve(__dirname, ".."),
  entryPoints: ["src/code.ts"],
  bundle: true,
  outfile: "code.js",
  target: "es6",
  logLevel: "warning"
};

async function build() {
  if (process.argv.includes("--watch")) {
    const context = await esbuild.context(options);
    await context.watch();
  } else {
    await esbuild.build(options);
  }
}

build().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
