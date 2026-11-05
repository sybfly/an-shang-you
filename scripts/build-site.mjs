/**
 * 打发布包：把真正要公开的静态文件复制到 dist/。
 *
 * 这个站点没有构建、没有后端，index.html 直接引用同级目录，
 * 所以这里只做「挑文件 + 检查引用」两件事，不压缩、不转译。
 *
 * 用法：node scripts/build-site.mjs
 */

import { cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

// 白名单：只发布运行站点需要的文件。
const ENTRIES = [
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'js',
  'vendor',
  'assets',
  '_headers',
  '.nojekyll'
];

// 首页里这些前缀不是本地文件，跳过检查。
const EXTERNAL = /^(?:https?:|data:|mailto:|tel:|#|\/\/)/i;

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

const missing = [];
for (const entry of ENTRIES) {
  if (!(await exists(path.join(root, entry)))) missing.push(entry);
}
if (missing.length > 0) {
  console.error(`发布失败：缺少文件/目录 ${missing.join('、')}`);
  process.exit(1);
}

const html = await readFile(path.join(root, 'index.html'), 'utf8');
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map((match) => match[1].trim())
  .filter((ref) => ref && !EXTERNAL.test(ref));

const brokenRefs = [];
for (const ref of refs) {
  if (ref.startsWith('/')) {
    brokenRefs.push(`${ref}（根路径引用，部署到 GitHub Pages 子目录会失效）`);
    continue;
  }
  const clean = ref.split('?')[0].split('#')[0];
  if (clean && !(await exists(path.join(root, clean)))) brokenRefs.push(ref);
}
if (brokenRefs.length > 0) {
  console.error(`发布失败：首页引用了不存在的文件\n  - ${brokenRefs.join('\n  - ')}`);
  process.exit(1);
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

async function walk(dir) {
  let count = 0;
  let size = 0;
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const itemPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      const nested = await walk(itemPath);
      count += nested.count;
      size += nested.size;
    } else {
      count += 1;
      size += (await stat(itemPath)).size;
    }
  }
  return { count, size };
}

for (const entry of ENTRIES) {
  await cp(path.join(root, entry), path.join(dist, entry), { recursive: true });
}

const totals = await walk(dist);
const files = totals.count;
const bytes = totals.size;

console.log(`已生成 dist/：${files} 个文件，${(bytes / 1024).toFixed(1)} KB`);
console.log('可把 dist/ 整个目录拖到 Cloudflare Pages，或交给 GitHub Actions 发布。');
