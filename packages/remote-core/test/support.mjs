// Repo paths shared by the remote-core tests: the protocol fixtures and the Node fake camera.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export { startFakeCamera, loadFakeImages } from '../../../protocol/tools/probe-client/fake-camera.mjs';

export const SRC_DIR = fileURLToPath(new URL('../src/', import.meta.url));
export const FIXTURES_DIR = fileURLToPath(new URL('../../../protocol/fixtures/', import.meta.url));

/** Parsed `protocol/fixtures/<name>`. */
export const fixture = (name) => JSON.parse(readFileSync(FIXTURES_DIR + name, 'utf8'));

/** File names in `protocol/fixtures/`, sorted. */
export const fixtureNames = () => readdirSync(FIXTURES_DIR).filter((n) => n.endsWith('.json')).sort();
