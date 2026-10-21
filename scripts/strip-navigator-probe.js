/**
 * oauth4webapi and openid-client probe `navigator` while the module loads.
 * VS Code's extension host logs a PendingMigrationError on any read of that
 * global, which shows up as a hard error while a workspace connection starts.
 * This extension always runs in Node, so the probe can be treated as true.
 */
function stripNavigatorProbe(source) {
  return source.replace(
    /if \(typeof navigator === 'undefined' \|\| !navigator\.userAgent\?\.startsWith\?\.\('Mozilla\/5\.0 '\)\) \{/g,
    'if (true) {'
  );
}

module.exports = { stripNavigatorProbe };
