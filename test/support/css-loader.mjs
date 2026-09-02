export async function load(url, context, nextLoad) {
  if (!url.endsWith('.css')) return nextLoad(url, context);
  return {
    format: 'module',
    shortCircuit: true,
    source: 'export default "";',
  };
}
