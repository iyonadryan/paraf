// Writes the flow definition JSON Schema to dist/flow.schema.json so it can be
// imported as `@paraf/core/flow.schema.json` (e.g. by IDEs or other validators).
import { writeFileSync } from 'node:fs';
import { flowSchema } from '../dist/index.js';

const target = new URL('../dist/flow.schema.json', import.meta.url);
writeFileSync(target, JSON.stringify(flowSchema, null, 2) + '\n');
