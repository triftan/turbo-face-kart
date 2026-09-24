// Online leaderboard for Turbo Face Kart.
// GET  /api/leaderboard?world=meadow  -> { top: [...] }            top 10 for one world
// GET  /api/leaderboard               -> { worlds: { meadow: [...], ... } }  top 10 for every world
// POST /api/leaderboard {world,name,time,lap,place,kart} -> { id, rank, total, top }
import { neon } from '@neondatabase/serverless';
import { createHash } from 'node:crypto';

// fastest believable 3-lap time per world in seconds (the best test runs are well above these)
const MIN_TIME = { meadow: 55, desert: 80, frost: 82, volcano: 85 };
const KARTS = ['Classic', 'Bolt', 'Tank', 'Zippy'];
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

let sql = null, ready = null;
function db() {
  if (!sql) sql = neon(process.env.DATABASE_URL);
  if (!ready) {
    ready = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS scores (
        id bigserial PRIMARY KEY,
        world text NOT NULL,
        name text NOT NULL,
        time real NOT NULL,
        lap real NOT NULL,
        place smallint NOT NULL,
        kart text NOT NULL,
        ip_hash text,
        created_at timestamptz NOT NULL DEFAULT now())`;
      await sql`CREATE INDEX IF NOT EXISTS scores_world_time ON scores (world, time, id)`;
      await sql`CREATE INDEX IF NOT EXISTS scores_ip_time ON scores (ip_hash, created_at)`;
    })().catch((e) => { ready = null; throw e; });
  }
  return ready.then(() => sql);
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS } });

async function top(s, world) {
  return s`SELECT id, name, time, lap, place, kart, to_char(created_at, 'YYYY-MM-DD') AS date
           FROM scores WHERE world = ${world} ORDER BY time ASC, id ASC LIMIT 10`;
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(request) {
  try {
    const world = new URL(request.url).searchParams.get('world');
    const s = await db();
    if (world) {
      if (!(world in MIN_TIME)) return json({ error: 'unknown world' }, 400);
      return json({ top: await top(s, world) });
    }
    const rows = await s`SELECT world, id, name, time, lap, place, kart, date FROM (
        SELECT *, to_char(created_at, 'YYYY-MM-DD') AS date,
               row_number() OVER (PARTITION BY world ORDER BY time ASC, id ASC) AS rn
        FROM scores) t WHERE rn <= 10 ORDER BY world, time ASC, id ASC`;
    const worlds = {};
    for (const w of Object.keys(MIN_TIME)) worlds[w] = [];
    for (const r of rows) if (worlds[r.world]) { const { world, ...rest } = r; worlds[world].push(rest); }
    return json({ worlds });
  } catch (e) {
    console.error(e);
    return json({ error: 'leaderboard unavailable' }, 500);
  }
}

export async function POST(request) {
  let b;
  try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400); }
  const world = String(b?.world || '');
  const time = Number(b?.time), lap = Number(b?.lap), place = Number(b?.place);
  const kart = KARTS.includes(b?.kart) ? b.kart : null;
  const name = String(b?.name || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 12) || 'Racer';
  if (!(world in MIN_TIME)) return json({ error: 'unknown world' }, 400);
  if (!Number.isFinite(time) || time < MIN_TIME[world] || time > 3600) return json({ error: 'time out of range' }, 400);
  if (!Number.isFinite(lap) || lap < time / 6 || lap > time) return json({ error: 'lap out of range' }, 400);
  if (!Number.isInteger(place) || place < 1 || place > 6) return json({ error: 'bad place' }, 400);
  if (!kart) return json({ error: 'bad kart' }, 400);

  const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  const ipHash = createHash('sha256').update('fk:' + ip).digest('hex').slice(0, 32);
  try {
    const s = await db();
    // one finished race per 15 s per player, and at most 300 a day
    const [lim] = await s`SELECT
        count(*) FILTER (WHERE created_at > now() - interval '15 seconds') AS recent,
        count(*) FILTER (WHERE created_at > now() - interval '1 day') AS day
      FROM scores WHERE ip_hash = ${ipHash} AND created_at > now() - interval '1 day'`;
    if (Number(lim.recent) > 0 || Number(lim.day) >= 300) return json({ error: 'slow down' }, 429);
    const [row] = await s`INSERT INTO scores (world, name, time, lap, place, kart, ip_hash)
        VALUES (${world}, ${name}, ${Math.round(time * 1000) / 1000}, ${Math.round(lap * 1000) / 1000}, ${place}, ${kart}, ${ipHash})
        RETURNING id, time`;
    const [{ ahead, total }] = await s`SELECT
        count(*) FILTER (WHERE time < ${row.time} OR (time = ${row.time} AND id < ${row.id})) AS ahead,
        count(*) AS total FROM scores WHERE world = ${world}`;
    return json({ id: row.id, rank: Number(ahead) + 1, total: Number(total), top: await top(s, world) });
  } catch (e) {
    console.error(e);
    return json({ error: 'leaderboard unavailable' }, 500);
  }
}
