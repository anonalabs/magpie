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
