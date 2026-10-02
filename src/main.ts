/**
 * Close Reflect — plugin entry point.
 *
 * This file is the build input. The plugin Obsidian loads is the bundled `main.js` at
 * the repository root, produced by `bun run build`; edit the modules under `src/`,
 * never the bundle.
 */
import CloseReflectPlugin from './plugin';

// Obsidian evaluates the bundle as CommonJS and takes the module itself as the plugin
// class, so the entry assigns module.exports directly rather than exposing a default
// property.
module.exports = CloseReflectPlugin;
