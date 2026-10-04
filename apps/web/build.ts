import { copyFile, mkdir, rm, watch } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { build, context, type BuildOptions } from 'esbuild';

const { values } = parseArgs({ options: { watch: { type: 'boolean', default: false } } });
const root = import.meta.dirname;
const dist = join(root, 'dist');
const staticFiles = new Map([
  ['index.html', 'index.html'],
  ['favicon.ico', 'favicon.ico'],
  ['styles.css', 'assets/styles.css'],
]);

const options: BuildOptions = {
  entryPoints: [join(root, 'src/main.ts')],
  outfile: join(dist, 'assets/app.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: !values.watch,
  sourcemap: values.watch,
  logLevel: 'info',
};

await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, 'assets'), { recursive: true });
await Promise.all(
  [...staticFiles].map(([file, target]) => copyFile(join(root, file), join(dist, target))),
);

if (values.watch) {
  await (await context(options)).watch();
  // esbuild watches only the bundle's inputs; the copied files need their own watcher.
  for await (const { filename } of watch(root)) {
    const target = filename === null ? undefined : staticFiles.get(filename);
    if (filename === null || target === undefined) continue;
    try {
      await copyFile(join(root, filename), join(dist, target));
    } catch (error) {
      // A save by rename or a checkout removes the file for a moment; its re-creation is a
      // further event that copies it.
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
} else {
  await build(options);
}
