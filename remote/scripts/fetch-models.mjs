// Build script: fetches the MediaPipe Interactive Segmenter model (not in git) into a cache outside
// the repo (~/.kopernikadr/models/<sha256>.task), verifies it, and copies it into the git-ignored
// Android assets. Run: `node scripts/fetch-models.mjs` from remote/. The Gradle task `checkSegModel`
// refuses to build without a verified copy.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SEG_MODEL = {
  url: 'https://storage.googleapis.com/mediapipe-models/interactive_segmenter_v2/magic_touch/int8/1/interactive_segmentation.task',
  sha256: '38431bc66b883404e8397f74c3579404315b9b52b04a46c6346fe906a7309b03',
  bytes: 30525312,
};

const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** True when `file` exists and has the model's size and sha256. */
function matches(file, model) {
  try {
    return fs.statSync(file).size === model.bytes && sha256File(file) === model.sha256;
  } catch {
    return false;
  }
}

/**
 * Makes `assetPath` a verified copy of the model. Order: asset already fine (skip), cache hit (copy),
 * else download into the cache (`fetchFn(url)` returns a fetch Response), verify, copy. A bad
 * download is never stored and the call throws; a bad cache file is deleted first.
 * @returns {Promise<'asset'|'cache'|'download'>} where the file came from
 */
export async function fetchModel({ model = SEG_MODEL, cacheDir, assetPath, fetchFn = fetch }) {
  if (matches(assetPath, model)) return 'asset';
  const cached = path.join(cacheDir, `${model.sha256}.task`);
  let source = 'cache';
  if (!matches(cached, model)) {
    fs.rmSync(cached, { force: true });
    const res = await fetchFn(model.url);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${model.url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const got = crypto.createHash('sha256').update(buf).digest('hex');
    if (buf.length !== model.bytes || got !== model.sha256) {
      throw new Error(`downloaded model is wrong (${buf.length} bytes, sha256 ${got}); expected ${model.bytes} bytes, ${model.sha256}`);
    }
    fs.mkdirSync(cacheDir, { recursive: true });
    const part = `${cached}.part-${process.pid}`;
    fs.writeFileSync(part, buf);
    fs.renameSync(part, cached);
    source = 'download';
  }
  fs.mkdirSync(path.dirname(assetPath), { recursive: true });
  const part = `${assetPath}.part-${process.pid}`;
  fs.copyFileSync(cached, part);
  fs.renameSync(part, assetPath);
  return source;
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = await fetchModel({
    cacheDir: path.join(os.homedir(), '.kopernikadr', 'models'),
    assetPath: path.join(here, '..', 'android', 'app', 'src', 'main', 'assets', 'mediapipe', 'interactive_segmentation.task'),
  });
  console.log(`models: interactive_segmentation.task ok (${source})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`models: ${e.message}`);
    process.exit(1);
  });
}
