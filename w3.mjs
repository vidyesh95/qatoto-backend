import pg from "pg"; import { readFileSync } from "node:fs";
const url = readFileSync(".env","utf8").split("\n").find(l=>l.startsWith("DATABASE_URL="))?.slice(13).replace(/^["']|["']$/g,"").replace(/[?&]sslmode=[^&]*/,"");
const c = new pg.Client({ connectionString: url, ssl:{rejectUnauthorized:false} }); await c.connect();
for (let i = 0; i < 200; i++) {
  const j = await c.query(`SELECT state, count(*)::int AS n FROM pgboss.job
    WHERE name='generate-localization-narrative' AND created_on > now() - interval '120 minutes' GROUP BY state`);
  const s = await c.query(`SELECT count(*)::int AS n FROM localization_pathway_suggestion WHERE prompt_version='localization-narrative-v3'`);
  const live = j.rows.filter(r=>["created","retry","active"].includes(r.state)).reduce((t,r)=>t+r.n,0);
  if (i % 10 === 0) console.log(new Date().toISOString().slice(11,19), `written=${s.rows[0].n} live=${live}`);
  if (live === 0) { console.log("DRAINED at", new Date().toISOString().slice(11,19), "written v3 =", s.rows[0].n, "|", j.rows.map(r=>r.state+':'+r.n).join(' ')); break; }
  await new Promise(r => setTimeout(r, 30000));
}
await c.end();
