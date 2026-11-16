// Driver: reads /input/cases.json, renders each case alone with parse() from
// parse.js, writes /output/html.json (one HTML string per case, in order).
// Outside a container MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR stand in.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; markdown: string }[];
const html: string[] = [];
for (const c of cases) html.push(parse(c.markdown));
writeFileSync(join(OUTPUT_DIR, 'html.json'), JSON.stringify(html));
