// Read-only production checks. No sendMessage, setWebhook, or historical replay.
import fs from 'node:fs/promises';
import dotenv from 'dotenv';
import pg from 'pg';
const env=dotenv.parse(await fs.readFile('.env.local'));
const base=env.PUBLIC_BASE_URL || 'https://wp-voice-ping-production.up.railway.app';
const report={at:new Date().toISOString()};
async function request(path,options={}) {
  const r=await fetch(base+path,{...options,signal:AbortSignal.timeout(15000)});
  return {status:r.status,body:await r.json()};
}
report.health=await request('/health');
const sales=await request('/admin/sales',{headers:{authorization:`Bearer ${env.ADMIN_API_TOKEN}`}});
report.admin={status:sales.status,count:sales.body.sales?.length};
report.webhooks={};
for(const [name,path,header,secret] of [
  ['ghl','/webhooks/ghl/voice-ai-call-completed','x-wp-voice-ping-secret',env.GHL_WEBHOOK_SECRET],
  ['telegram','/telegram/webhook','x-telegram-bot-api-secret-token',env.TELEGRAM_WEBHOOK_SECRET],
]) {
  const opts={method:'POST',headers:{'content-type':'application/json'},body:'{}'};
  const unauthorized=await request(path,opts);
  const authorized=await request(path,{...opts,headers:{...opts.headers,[header]:secret}});
  report.webhooks[name]={unauthorized:unauthorized.status,authorizedInvalidPayload:authorized.status};
}
for(const method of ['getMe','getWebhookInfo']) {
  const r=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,{signal:AbortSignal.timeout(15000)});
  const data=await r.json();
  if(!data.ok)throw new Error(`${method} failed`);
  report[method]=method==='getMe'?{username:data.result.username}: {
    url:data.result.url,pendingUpdates:data.result.pending_update_count,
    lastErrorDate:data.result.last_error_date??null,lastErrorMessage:data.result.last_error_message??null,
  };
}
const db=new pg.Client({connectionString:env.DATABASE_URL});
await db.connect();
try {
  report.databaseHost=new URL(env.DATABASE_URL).hostname;
  report.staff=(await db.query(`SELECT count(*) AS staff,
    count(*) FILTER (WHERE s.active AND b.active AND b.verified_at IS NOT NULL) connected,
    count(*) FILTER (WHERE s.active AND s.is_admin AND b.active AND b.verified_at IS NOT NULL) all_call_recipients,
    count(*) FILTER (WHERE s.active AND s.can_manage_bot AND b.active AND b.verified_at IS NOT NULL) managers
    FROM wp_voice_ping.sales_users s LEFT JOIN wp_voice_ping.telegram_bindings b ON b.sales_user_id=s.id`)).rows[0];
  report.gate=(await db.query('SELECT accepting FROM wp_voice_ping.migration_state')).rows[0];
  report.events=(await db.query('SELECT status,count(*) FROM wp_voice_ping.call_events GROUP BY status ORDER BY status')).rows;
  report.deliveries=(await db.query('SELECT status,count(*) FROM wp_voice_ping.notification_deliveries GROUP BY status ORDER BY status')).rows;
  report.queued=(await db.query('SELECT count(*) FROM wp_voice_ping.migration_inbox WHERE forwarded_at IS NULL')).rows[0];
} finally {await db.end();}
const ok=report.health.status===200&&report.admin.status===200&&report.admin.count===12&&report.gate.accepting&&
  Object.values(report.webhooks).every(x=>x.unauthorized===401&&x.authorizedInvalidPayload===422)&&
  report.getWebhookInfo.url===base+'/telegram/webhook';
report.checksPassed=ok;
await fs.writeFile('tmp/database-migration/verification.json',JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify(report,null,2));
if(!ok)process.exitCode=1;
