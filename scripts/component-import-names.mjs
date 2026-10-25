/** Stable semantic imports: adding a directory must not renumber existing bindings. */
export function componentImportNames(names) {
  const identifiers = names.map(name => `${name.replace(/-([a-z0-9])/gu, (_match, next) => next.toUpperCase())}Component`);
  if (new Set(identifiers).size !== identifiers.length) throw new Error('component_import_name_collision');
  return identifiers;
}
