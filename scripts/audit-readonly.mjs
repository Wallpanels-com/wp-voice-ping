import dotenv from 'dotenv';
import pg from 'pg';
dotenv.config({path:'.env.local',quiet:true});
const env=process.env;
const db=new pg.Client({connectionString:env.DATABASE_URL});
await db.connect();
try {
  const health=await fetch('https://wp-voice-ping-production.up.railway.app/health');
  console.log('health',health.status,await health.json());
  for(const method of ['getMe','getWebhookInfo']) {
    const r=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`);
    const j=await r.json();
    console.log(method,{ok:j.ok,username:j.result?.username,url:j.result?.url,pending:j.result?.pending_update_count,last_error:j.result?.last_error_message,last_error_date:j.result?.last_error_date});
  }
  for(const path of ['/webhooks/ghl/voice-ai-call-completed','/telegram/webhook','/admin/sales']) {
    const r=await fetch('https://wp-voice-ping-production.up.railway.app'+path,path==='/admin/sales'?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    console.log('unauthenticated',path,r.status);
  }
  const locations=await db.query('SELECT id, name, api_token_env_name FROM wp_voice_ping.crm_locations WHERE active');
  for(const l of locations.rows) {
    const headers={Authorization:`Bearer ${env[l.api_token_env_name]}`,Version:'2021-07-28'};
    const u=await fetch(`https://services.leadconnectorhq.com/users/?locationId=${l.id}`,{headers});
    const j=await u.json();
    console.log('GHL users',l.name,u.status,'count',j.users?.length);
    const w=await fetch(`https://services.leadconnectorhq.com/workflows/?locationId=${l.id}`,{headers});
    const wj=await w.json();
    console.log('workflows',l.name,w.status, wj.workflows?.filter(x=>/voice|ping/i.test(x.name)).map(x=>({name:x.name,status:x.status})));
    const failures=await db.query("SELECT id,contact_id FROM wp_voice_ping.call_events WHERE location_id=$1 AND reason='ghl_conversation_not_found'",[l.id]);
    for(const f of failures.rows) {
      const r=await fetch(`https://services.leadconnectorhq.com/conversations/search?locationId=${l.id}&contactId=${f.contact_id}&limit=1`,{headers:{...headers,Version:'2021-04-15'}});
      const j=await r.json();
      console.log('failed conversation lookup', {event:f.id,http:r.status,count:j.conversations?.length,fields:j.conversations?.[0]?Object.keys(j.conversations[0]):[],matchesContact:j.conversations?.[0]?.contactId===f.contact_id,matchesLocation:j.conversations?.[0]?.locationId===l.id});
    }
  }
} finally {await db.end();}
