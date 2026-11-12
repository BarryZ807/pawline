import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

// Prisma 6 Studio needs a writable engine cache. Keep it separate from the
// application image, using its already installed engine and non-root user.
const require = createRequire("/app/package.json");
const runtime = "/tmp/pawline-database-ui";
const cli = path.join(runtime, "prisma");
fs.mkdirSync(runtime, { recursive: true });
if (!fs.existsSync(cli)) {
  fs.cpSync("/app/node_modules/prisma", cli, { recursive: true });
}
const dependencies = path.join(runtime, "node_modules");
if (!fs.existsSync(dependencies)) {
  fs.symlinkSync("/app/node_modules", dependencies);
}

const engineDir = "/app/node_modules/@prisma/engines";
const engines = fs.readdirSync(engineDir).filter((name) =>
  /^libquery_engine-.*\.so\.node$/.test(name),
);
if (engines.length !== 1) {
  throw new Error("Expected one Linux query engine in the application image.");
}
const engine = path.join(engineDir, engines[0]);
const cache = path.join(cli, "engines", require("@prisma/engines-version").enginesVersion);
fs.mkdirSync(cache, { recursive: true });
const cachedEngine = path.join(cache, engines[0]);
if (!fs.existsSync(cachedEngine)) fs.symlinkSync(engine, cachedEngine);

// The bundled Studio CSS requests fonts relative to /index.css, while the
// package stores them in /assets. Supply local links in this private copy.
const publicDir = path.join(cli, "build/public");
for (const name of fs.readdirSync(path.join(publicDir, "assets"))) {
  if (!/\.woff2?$/.test(name)) continue;
  const target = path.join(publicDir, name);
  if (!fs.existsSync(target)) fs.symlinkSync(`assets/${name}`, target);
}

const child = spawn(process.execPath, [
  path.join(cli, "build/index.js"), "studio",
  "--schema", "/app/prisma/schema.prisma",
  "--hostname", "0.0.0.0", "--port", "5555", "--browser", "none",
], {
  cwd: "/app",
  stdio: "inherit",
  env: { ...process.env, PRISMA_QUERY_ENGINE_LIBRARY: engine },
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 0 : 1)));
