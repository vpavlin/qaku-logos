// Metro config - the integration seam that lets React Native bundle the SHARED
// engine/contract packages (plain ESM `.mjs` in ../packages), so the phone folds
// state with the EXACT same engine as the desktop core and the TS reference - no
// vendored fork, no drift.
//
// Out-of-the-box Metro problems with this setup, and the fix for each:
//  1. The packages live OUTSIDE mobile/ -> add ../packages to `watchFolders`
//     (watch ../packages specifically, NOT the repo-root ancestor, which confuses
//     Metro's crawler into "Failed to get the SHA-1").
//  2. `packages/contract/src/events.mjs` imports `randomUUID` from `node:crypto`,
//     which does not exist in React Native -> a `resolveRequest` rewrites
//     `node:crypto` (and bare `crypto`) to a tiny Expo-backed shim (shims/crypto.js).
//  3. Watchman/lazy-SHA1 hazards for files outside the project root -> force the
//     Node crawler and eager SHA-1.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, "..");
const packagesRoot = path.resolve(repoRoot, "packages");

const config = getDefaultConfig(projectRoot);

// (3) Watchman is not always installed; when Metro probes for it and it is
// missing, external watchFolders can drop out of the file map ("Failed to get the
// SHA-1"). Force Metro's Node crawler + eager hashing.
config.resolver.useWatchman = false;
config.watcher = config.watcher || {};
config.watcher.unstable_lazySha1 = false;

// (1) Watch the shared packages so Metro maps their .mjs sources.
config.watchFolders = [packagesRoot];

// (2) `.mjs` is source.
config.resolver.sourceExts = Array.from(new Set([...config.resolver.sourceExts, "mjs"]));

config.resolver.nodeModulesPaths = [
  path.join(projectRoot, "node_modules"),
  path.join(repoRoot, "node_modules"),
];

// (2) Intercept the Node core `crypto` import -> Expo-backed shim. The shared
// contract only needs randomUUID; mobile's own AEAD/topic crypto is @noble.
const cryptoShim = path.resolve(projectRoot, "shims/crypto.js");
const EXPLICIT = { "node:crypto": cryptoShim, crypto: cryptoShim };

const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const target = EXPLICIT[moduleName];
  if (target) return { type: "sourceFile", filePath: target };
  if (defaultResolveRequest) return defaultResolveRequest(context, moduleName, platform);
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
