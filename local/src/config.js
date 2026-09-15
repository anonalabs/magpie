// Where things live, and the token that guards them.
//
// The token is the whole security model at rest: any page you visit can reach
// 127.0.0.1, so a store holding the full text of everything you have read is a
// public API to your reading history until something proves the caller is
// magpie. It is generated once, on first run, and printed once.

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOME = process.env.MAGPIE_HOME ?? join(homedir(), '.magpie');
export const DB_PATH = join(HOME, 'memories.db');
export const TOKEN_PATH = join(HOME, 'token');
export const DEFAULT_PORT = Number(process.env.MAGPIE_PORT ?? 7777);

/** The embedding model, recorded on every vector so a change is detectable. */
export const EMBED_MODEL = process.env.MAGPIE_EMBED_MODEL ?? 'Xenova/bge-small-en-v1.5';
export const EMBED_DIM = 384;

export function ensureHome() {
  if (!existsSync(HOME)) mkdirSync(HOME, { recursive: true, mode: 0o700 });
  return HOME;
}

/**
 * The token, made if it does not exist yet. Mode 600: the file is a credential,
 * and the database beside it is not encrypted either, so the directory's
 * permissions are the only thing standing between another account on this
 * machine and everything you have read.
 */
export function token() {
  ensureHome();
  if (existsSync(TOKEN_PATH)) return readFileSync(TOKEN_PATH, 'utf8').trim();

  const made = `magpie_local_${randomBytes(24).toString('hex')}`;
  writeFileSync(TOKEN_PATH, `${made}\n`, { mode: 0o600 });
  chmodSync(TOKEN_PATH, 0o600);
  return made;
}

/** True the first time a token is asked for, so the CLI can say so. */
export const tokenExists = () => existsSync(TOKEN_PATH);
