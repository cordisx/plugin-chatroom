/** Retains one browser ESM load for the lifetime of the owning loader. */
export function loadModuleOnce<Module>(load: () => Promise<Module>): () => Promise<Module> {
  let current: Promise<Module> | undefined;
  return () => current ??= load();
}
