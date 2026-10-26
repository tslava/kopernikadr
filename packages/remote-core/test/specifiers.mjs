// Module specifier scan, shared with remote-lite's imports.test.mjs.

/** Every module specifier in a source file: static import/export … from, side-effect import, import(). */
export function specifiers(code) {
  const noComments = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  const out = [];
  const patterns = [
    /\b(?:import|export)\s[^'"`;]*?\bfrom\s*(['"`])([^'"`]+)\1/g,
    /\bimport\s*(['"`])([^'"`]+)\1/g,
    /\bimport\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g,
  ];
  for (const re of patterns) for (const m of noComments.matchAll(re)) out.push(m[2]);
  return out;
}
