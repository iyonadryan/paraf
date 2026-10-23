// Regenerates schema.postgres.sql from the migrations in src/schema.ts.
import { writeFileSync } from 'node:fs';
import { schemaSql } from '../src/schema.ts';

writeFileSync(new URL('../schema.postgres.sql', import.meta.url), schemaSql());
