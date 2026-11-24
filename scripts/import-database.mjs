// Import only into an EMPTY wp_voice_ping schema; leave public untouched.
import fs from 'node:fs/promises';
import dotenv from 'dotenv';
import pg from 'pg';
import { createHash } from 'node:crypto';
const env = dotenv.parse(await fs.readFile('.env.supabase-migration'));
const db = new pg.Client({connectionString:env.DATABASE_URL});
const snapshot=JSON.parse(await fs.readFile('tmp/database-migration/snapshot.json','utf8'));
const order=['crm_locations','sales_users','sales_location_users','telegram_bindings','call_events',
  'notification_deliveries','connection_codes','telegram_access_requests','schema_migrations'];
const digest=rs=>createHash('sha256').update(rs.join('\n')).digest('hex');
await db.connect();
try {
  await db.query('BEGIN');
  for(const table of order){
    const full=`wp_voice_ping.${table}`;
    const count=Number((await db.query(`SELECT count(*) n FROM ${full}`)).rows[0].n);
    if(count!==0)throw new Error(`Refusing to overwrite non-empty ${table}`);
    for(let i=0;i<snapshot[table].length;i+=100){
      await db.query(`INSERT INTO ${full} SELECT * FROM json_populate_recordset(NULL::${full},$1::json)`,
        ['['+snapshot[table].slice(i,i+100).join(',')+']']);
    }
    const rows=(await db.query(`SELECT row_to_json(t)::text value FROM ${full} t ORDER BY ${table==='schema_migrations'?'filename':'id'}`)).rows.map(r=>r.value);
    if(digest(rows)!==digest(snapshot[table]))throw new Error(`Checksum mismatch for ${table}`);
    console.log(`${table}: ${rows.length} rows, checksum matches`);
  }
  await db.query('COMMIT');
  console.log('All nine application tables copied exactly; target migration gate remains open.');
} catch(error) { await db.query('ROLLBACK'); throw error; }
finally { await db.end(); }
