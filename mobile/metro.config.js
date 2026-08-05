// Metro config: watch the repo root so mobile can import the SHARED reference
// engine/contract (packages/**) - the same fold the desktop core and the TS
// reference use, so the phone cannot diverge. Also allow the .mjs extension.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, "..");

const config = getDefaultConfig(projectRoot);
config.watchFolders = [repoRoot];
config.resolver.sourceExts = [...config.resolver.sourceExts, "mjs"];
config.resolver.nodeModulesPaths = [
  path.join(projectRoot, "node_modules"),
  path.join(repoRoot, "node_modules"),
];
module.exports = config;
