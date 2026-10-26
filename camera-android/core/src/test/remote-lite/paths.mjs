// Paths shared by the remote-lite tests.
//
// The shipped remote-lite/lib/ is a merge of two source roots (core/build.gradle.kts,
// syncRemoteCore): src/main/resources/remote-lite/lib/ and packages/remote-core/src/. The tests run
// on the sources, so importing this file installs a resolve hook that does the same merge: a module
// missing from remote-lite/lib/ (e.g. `./i18n-core.js` from i18n.js, or L('connection.js')) is
// loaded from remote-core/src/. imports.test.mjs checks the real merged build output.
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

export const REMOTE_LITE_DIR = fileURLToPath(new URL('../../main/resources/remote-lite/', import.meta.url));
export const LIB_DIR = fileURLToPath(new URL('../../main/resources/remote-lite/lib/', import.meta.url));
export const CORE_SRC_DIR = fileURLToPath(new URL('../../../../../packages/remote-core/src/', import.meta.url));
/** The merged output of `./gradlew-jbr :core:processResources` (what the APK ships). */
export const BUILT_REMOTE_LITE_DIR = fileURLToPath(new URL('../../../build/resources/main/remote-lite/', import.meta.url));
export const FAKE_CAMERA = new URL('../../../../../protocol/tools/probe-client/fake-camera.mjs', import.meta.url).href;

const LIB_URL = new URL('../../main/resources/remote-lite/lib/', import.meta.url).href;
const CORE_URL = new URL('../../../../../packages/remote-core/src/', import.meta.url).href;

if (typeof registerHooks !== 'function') {
  throw new Error(`remote-lite tests need Node >= 22.15 (module.registerHooks); this is ${process.version}`);
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL && (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('file:'))) {
      const target = new URL(specifier, context.parentURL);
      if (target.href.startsWith(LIB_URL) && !existsSync(target)) {
        const core = new URL(target.href.slice(LIB_URL.length), CORE_URL);
        if (existsSync(core)) return { url: core.href, format: 'module', shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

/** URL of a module in remote-lite/lib/ (remote-core modules resolve through the hook above). */
export const L = (name) => new URL(name, LIB_URL).href;
