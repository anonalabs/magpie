// node:sqlite announces that it is experimental, on stderr, on every run.
//
// Imported first by the CLI so it is in place before the database module is
// evaluated. The default printer is a listener Node registers at bootstrap, so
// it is replaced rather than wrapped: patching `process.emitWarning` does not
// catch this one, which is emitted through the listener path.
//
// Only that warning is dropped. Everything else Node has to say still prints,
// because a suppressed warning nobody sees is how a real one gets missed.
process.removeAllListeners('warning');

process.on('warning', (warning) => {
  const text = String(warning?.message ?? warning);
  if (warning?.name === 'ExperimentalWarning' && text.includes('SQLite')) return;
  console.error(`${warning?.name ?? 'Warning'}: ${text}`);
});

/**
 * Node 22.5 or newer, said plainly.
 *
 * The database is Node's own `node:sqlite`, which older versions do not have.
 * Importing it there throws ERR_UNKNOWN_BUILTIN_MODULE with a stack trace into
 * the module loader, which tells you nothing about what to do. `engines` in
 * package.json is a warning npm prints and nothing enforces, and a service
 * manager running the wrong interpreter never sees it at all.
 */
export function supportedNode(version) {
  const [major, minor] = String(version).split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 5);
}

if (!supportedNode(process.versions.node)) {
  console.error(`magpie-local needs Node 22.5 or newer. This is Node ${process.versions.node}.`);
  console.error('Its database is node:sqlite, which older versions do not carry.');
  console.error(`The binary being run is ${process.execPath}.`);
  process.exit(1);
}
