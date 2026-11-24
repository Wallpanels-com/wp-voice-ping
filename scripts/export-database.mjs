// Private, lossless snapshot for the one-time database move. Never logs rows.
import fs from 'node:fs/promises';
import dotenv from 'dotenv';
import pg from 'pg';
import { createHash } from 'node:crypto';

const env = dotenv.parse(await fs.readFile('.env.local'));
const db = new pg.Client({ connectionString: env.DATABASE_URL_UNPOOLED || env.DATABASE_URL });
const directory = 'tmp/database-migration';
const quote = (s) => '"' + s.replaceAll('"', '""') + '"';
await fs.mkdir(directory, { recursive: true, mode: 0o700 });
await db.connect();
try {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const tables = (await db.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='wp_voice_ping' AND c.relkind='r' ORDER BY c.relname`)).rows.map(r => r.relname);
  let ddl = 'CREATE SCHEMA wp_voice_ping AUTHORIZATION wp_voice_ping_app;\nSET ROLE wp_voice_ping_app;\n';
  let constraints = '', indexes = '';
  const snapshot = {};
  for (const table of tables) {
    const full = `wp_voice_ping.${quote(table)}`;
    const cols = (await db.query(`SELECT a.attname,format_type(a.atttypid,a.atttypmod) type,
      a.attnotnull,pg_get_expr(d.adbin,d.adrelid) def,a.attidentity,a.attgenerated
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,[full])).rows;
    if(cols.some(c=>c.attidentity || c.attgenerated || c.def?.includes('nextval('))) throw new Error('Unsupported sequence/generated column');
    ddl += `CREATE TABLE ${full} (\n${cols.map(c=>`  ${quote(c.attname)} ${c.type}${c.def ? ' DEFAULT '+c.def : ''}${c.attnotnull ? ' NOT NULL' : ''}`).join(',\n')}\n);\n`;
    for (const c of (await db.query(`SELECT conname,contype,pg_get_constraintdef(oid) def FROM pg_constraint WHERE conrelid=$1::regclass AND contype <> 'n' ORDER BY contype,conname`,[full])).rows) {
      constraints += `ALTER TABLE ${full} ADD CONSTRAINT ${quote(c.conname)} ${c.def};\n`;
    }
    for(const i of (await db.query(`SELECT pg_get_indexdef(i.indexrelid) def FROM pg_index i
      WHERE i.indrelid=$1::regclass AND NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conindid=i.indexrelid) ORDER BY i.indexrelid`,[full])).rows) indexes+=i.def+';\n';
    const rows = (await db.query(`SELECT row_to_json(t)::text AS value FROM ${full} t ORDER BY ${quote(table==='schema_migrations'?'filename':'id')}`)).rows.map(r=>r.value);
    snapshot[table] = rows;
  }
  // Add primary/unique keys before foreign keys.
  const lines=constraints.trim().split('\n');
  ddl += lines.filter(l=>!l.includes(' FOREIGN KEY ')).join('\n')+'\n';
  ddl += lines.filter(l=>l.includes(' FOREIGN KEY ')).join('\n')+'\n'+indexes;
  for(const table of tables) ddl+=`ALTER TABLE wp_voice_ping.${quote(table)} ENABLE ROW LEVEL SECURITY;\n`;
  ddl+='RESET ROLE;\nREVOKE ALL ON SCHEMA wp_voice_ping FROM PUBLIC, anon, authenticated;\nREVOKE ALL ON ALL TABLES IN SCHEMA wp_voice_ping FROM PUBLIC, anon, authenticated;\n';
  await db.query('COMMIT');
  await fs.writeFile(`${directory}/schema.sql`,ddl,{mode:0o600});
  await fs.writeFile(`${directory}/snapshot.json`,JSON.stringify(snapshot),{mode:0o600});
  const counts=Object.fromEntries(Object.entries(snapshot).map(([t,rs])=>[t,rs.length]));
  const hashes=Object.fromEntries(Object.entries(snapshot).map(([t,rs])=>[t,createHash('sha256').update(rs.join('\n')).digest('hex')]));
  await fs.writeFile(`${directory}/manifest.json`,JSON.stringify({at:new Date(),counts,hashes},null,2),{mode:0o600});
  console.log(JSON.stringify({counts,bytes:JSON.stringify(snapshot).length}));
} finally { await db.end(); }
