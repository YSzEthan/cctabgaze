// 調整版本號：bun run bump patch|minor|major。版本號只存在 extension/manifest.json，推上 main 後 CI 依它發版
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const file = join(import.meta.dirname, '../extension/manifest.json');
const part = ['major', 'minor', 'patch'].indexOf(process.argv[2] ?? '');
const text = readFileSync(file, 'utf8');
const m = /"version": "(\d+)\.(\d+)\.(\d+)"/.exec(text);
if (part < 0 || !m) {
  console.error(part < 0 ? '用法：bun run bump patch|minor|major' : 'manifest.json 的 version 不是 x.y.z');
  process.exit(1);
}
const nums = [Number(m[1]), Number(m[2]), Number(m[3])];
nums[part]!++;
nums.fill(0, part + 1);
const v = nums.join('.');
writeFileSync(file, text.replace(m[0], `"version": "${v}"`));
console.log(`${m[1]}.${m[2]}.${m[3]} → ${v}`);
