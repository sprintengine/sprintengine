const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// The phone imports the desktop's protocol packages from the repository's
// `packages/` folder, as source: Metro watches it, and the packages' NodeNext
// `.js` specifiers name TypeScript files there.
const packages = path.resolve(__dirname, "../packages");
config.watchFolders = [...(config.watchFolders ?? []), packages];
const resolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolveNext = resolve ?? context.resolveRequest;
  if (
    context.originModulePath.startsWith(packages + path.sep) &&
    (moduleName.startsWith("./") || moduleName.startsWith("../")) &&
    moduleName.endsWith(".js")
  ) {
    try {
      return resolveNext(context, moduleName.slice(0, -3) + ".ts", platform);
    } catch {
      // A real `.js` file, if a package ever reaches one, resolves as named.
    }
  }
  return resolveNext(context, moduleName, platform);
};

// Inline requires: a module runs the first time something uses it, not when
// the file that imports it loads. The navigators import every screen, so
// without this a cold start evaluated the chat screen's markdown, the HTML
// view's WebView, the camera and the speech recogniser before the first frame.
// Expo leaves it off by default; the app has no side-effect-only imports, which
// are the one thing it reorders.
const getTransformOptions = config.transformer.getTransformOptions;
config.transformer.getTransformOptions = async (...args) => {
  const options = await getTransformOptions(...args);
  return { ...options, transform: { ...options.transform, inlineRequires: true } };
};

module.exports = config;
