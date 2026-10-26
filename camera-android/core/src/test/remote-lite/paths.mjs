// Paths shared by the remote-lite tests.
import { fileURLToPath } from 'node:url';

export const REMOTE_LITE_DIR = fileURLToPath(new URL('../../main/resources/remote-lite/', import.meta.url));
export const FAKE_CAMERA = new URL('../../../../../protocol/tools/probe-client/fake-camera.mjs', import.meta.url).href;

/** URL of a module in remote-lite/lib/. */
export const L = (name) => new URL(`../../main/resources/remote-lite/lib/${name}`, import.meta.url).href;
