'use strict';

// ====================================================================
// ANALYTICS MODULI — KINOBOT statistika tizimi
// - Barcha hisoblar REAL database ma'lumotlariga asoslangan
// - Vaqt zonasi: Asia/Tashkent (kun 00:00 Tashkent bo'yicha boshlanadi)
// - Event tracking hech qachon asosiy bot jarayonini to'xtatmaydi
// ====================================================================

const TZ = 'Asia/Tashkent';
const PAGE = 10;

let gBot = null;
let gQuery = null;
let gAdminId = null;

// ---------- init ----------
function init(botRef, pgQueryRef, adminIdRef) {
    gBot = botRef;
    gQuery = pgQueryRef;
    gAdminId = adminIdRef;
}

// ---------- formatlash ----------
function fmt(n) {
    return String(Math.floor(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}
function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function pct(cur, prev) {
    const p = Number(prev) || 0;
    if (p <= 0) return 'Yangi';
    const d = ((Number(cur) - p) / p) * 100;
    return (d >= 0 ? '+' : '') + (Math.round(d * 10) / 10).toFixed(1).replace('.', ',') + '%';
}
function cap(s, n) {
    s = String(s || '');
    return s.length > (n || 30) ? s.slice(0, (n || 30) - 1) + '…' : s;
}

// ---------- vaqt (Asia/Tashkent) ----------
function tzDateStr(d) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d || new Date());
}
function dayStart(offsetDays) {
    return new Date(tzDateStr(new Date(Date.now() - (offsetDays || 0) * 86400000)) + 'T00:00:00+05:00');
}
function fmtLocalLong(d) {
    return new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit' }).format(d);
}

// ---------- EVENT TRACKING (fire-and-forget, hech qachon xato tashlamaydi) ----------
function trackEvent(eventType, userId, extra) {
    if (!gQuery || !userId) return;
    const movieCode = extra && extra.movie_code ? String(extra.movie_code) : null;
    const payload = extra && extra.payload != null ? String(extra.payload).slice(0, 120) : null;
    gQuery('INSERT INTO analytics_events (user_id, event_type, movie_code, payload) VALUES ($1,$2,$3,$4)',
        [userId, eventType, movieCode, payload]).catch(() => {});
}

function trackBlocked(userId, err) {
    if (!gQuery || !userId) return;
    const m = String((err && (err.message || err.description)) || '').toLowerCase();
    if (!m.includes('blocked')) return;
    gQuery('INSERT INTO blocked_users (chat_id) VALUES ($1) ON CONFLICT (chat_id) DO NOTHING', [userId]).catch(() => {});
}

// ---------- TUGMALAR ----------
const b = (t, d) => ({ text: t, callback_data: d });

function mainMenu() {
    return {
        inline_keyboard: [
            [b('📈 Umumiy statistika', 'st_dash')],
            [b('📅 Bugun', 'st_today'), b('🕐 Kecha', 'st_yest')],
            [b('🎬 Kinolar', 'st_movies'), b('👥 Foydalanuvchilar', 'st_users')],
            [b('📈 User o`si\'shi', 'st_growth'), b('⏰ Soatlik faollik', 'st_hourly')],
            [b('📅 Kunlik', 'st_daily'), b('🔍 Qidiruvlar', 'st_search')],
            [b('🚫 Bloklaganlar', 'st_blocked'), b('📤 CSV export', 'st_export')],
            [b('🔄 Yangilash', 'st_refresh')]
        ]
    };
}
function moviesMenu() {
    return {
        inline_keyboard: [
            [b('🔥 Bugun TOP', 'st_m_today')],
            [b('📅 Kecha TOP', 'st_m_yest')],
            [b('📈 Eng o\'sayotgan', 'st_m_growth')],
            [b('🏆 Umumiy TOP', 'st_m_all')],
            [b('🔙 Orqaga', 'st_menu')]
        ]
    };
}
function dailyMenu() {
    return {
        inline_keyboard: [
            [b('📅 7 kun', 'st_dr_7'), b('📅 14 kun', 'st_dr_14')],
            [b('📅 30 kun', 'st_dr_30'), b('📅 90 kun', 'st_dr_90')],
            [b('📅 Barcha vaqt', 'st_dr_0')],
            [b('🔙 Orqaga', 'st_menu')]
        ]
    };
}
function backRow(backTo) {
    return [b('🔙 Orqaga', backTo || 'st_menu')];
}

// ---------- KINO NOMLARI ----------
async function movieLabels(codes) {
    const uniq = [...new Set(codes.filter(Boolean))];
    const map = {};
    if (uniq.length === 0) return map;
    try {
        const r = await gQuery('SELECT code, caption FROM movies WHERE code = ANY($1)', [uniq]);
        for (const row of r.rows) map[row.code] = row.caption || ('Kino ' + row.code);
    } catch (e) {}
    for (const c of uniq) if (!map[c]) map[c] = 'Kino ' + c;
    return map;
}

// ====================================================================
// DASHBOARD — asosiy panel
// ====================================================================
async function dashboard() {
    const ts = dayStart(0);
    const ys = dayStart(1);
    const tsEnd = new Date(ts.getTime() + 86400000);
    const weekStart = dayStart(7);

    const [u, m, dl, nu, starts, actToday, actWeek, bl, topToday] = await Promise.all([
        gQuery('SELECT COUNT(*)::int c FROM users'),
        gQuery('SELECT COUNT(*)::int c, COALESCE(SUM(views),0)::bigint v FROM movies'),
        gQuery(`SELECT COUNT(*) FILTER (WHERE created_at >= $1) AS today,
                       COUNT(*) FILTER (WHERE created_at >= $2 AND created_at < $1) AS yest
                FROM analytics_events WHERE event_type = 'download' AND created_at >= $2`,
            [ts, ys]),
        gQuery(`SELECT COUNT(*) FILTER (WHERE joined_at >= $1) AS today,
                       COUNT(*) FILTER (WHERE joined_at >= $2 AND joined_at < $1) AS yest
                FROM users WHERE joined_at >= $2`, [ts, ys]),
        gQuery(`SELECT COUNT(*)::int c FROM analytics_events WHERE event_type = 'start' AND created_at >= $1`, [ts]),
        gQuery(`SELECT COUNT(DISTINCT user_id)::int c FROM analytics_events WHERE created_at >= $1`, [ts]),
        gQuery(`SELECT COUNT(DISTINCT user_id)::int c FROM analytics_events WHERE created_at >= $1`, [weekStart]),
        gQuery('SELECT COUNT(*)::int c FROM blocked_users'),
        gQuery(`SELECT movie_code, COUNT(*)::int c FROM analytics_events
                WHERE event_type = 'download' AND created_at >= $1 AND created_at < $2
                GROUP BY movie_code ORDER BY c DESC LIMIT 1`, [ts, tsEnd])
    ]);

    const labels = await movieLabels([topToday.rows[0] && topToday.rows[0].movie_code]);
    const topCode = topToday.rows[0] && topToday.rows[0].movie_code;
    const topName = topCode ? labels[topCode] : '—';

    const dlt = dl.rows[0];
    const nut = nu.rows[0];

    return `📊 <b>ASOSIY STATISTIKA</b>

👥 Foydalanuvchilar: <b>${fmt(u.rows[0].c)}</b>
🎬 Kinolar: <b>${fmt(m.rows[0].c)}</b>
📥 Jami yuklab olishlar: <b>${fmt(m.rows[0].v)}</b>

📅 <b>BUGUN</b> (${fmtLocalLong(ts)})
🆕 Yangi userlar: <b>${fmt(nut.today)}</b>  (kecha: ${fmt(nut.yest)})
📥 Yuklab olishlar: <b>${fmt(dlt.today)}</b>  (kecha: ${fmt(dlt.yest)})
📈 O\'sish: <b>${pct(nut.today, nut.yest)}</b> user / <b>${pct(dlt.today, dlt.yest)}</b> download
🔄 /start: <b>${fmt(starts.rows[0].c)}</b>

🟢 Faol bugun: <b>${fmt(actToday.rows[0].c)}</b>  |  7 kun: <b>${fmt(actWeek.rows[0].c)}</b>
🚫 Bloklagan: <b>${fmt(bl.rows[0].c)}</b>

🔥 Bugungi eng kuchli:
${topCode ? `${esc(cap(topName, 55))} — 📥 ${fmt(topToday.rows[0].c)}` : 'Hozircha ma\'lumot yo\'q'}`;
}

// ====================================================================
// KINO TOP RO'YXATLARI (pagination bilan)
// ====================================================================
async function renderTopList(key, page) {
    page = Math.max(1, Number(page) || 1);
    const off = (page - 1) * PAGE;
    const ts = dayStart(0);
    const ys = dayStart(1);
    const tsEnd = new Date(ts.getTime() + 86400000);

    let items = [];
    let total = 0;
    let title = '';

    if (key === 'ma') {
        title = '🏆 ENG KO\'P YUKLAB OLINGAN KINOLAR';
        const t = await gQuery('SELECT COUNT(*)::int c FROM movies');
        total = t.rows[0].c;
        const r = await gQuery('SELECT code, caption, views FROM movies ORDER BY views DESC, code LIMIT $1 OFFSET $2', [PAGE, off]);
        items = r.rows.map((m, i) => ({ lab: m.caption || ('Kino ' + m.code), sub: `📥 Jami: <b>${fmt(m.views)}</b>` }));
    } else if (key === 'mt') {
        title = '🔥 BUGUN TOP KINOLAR';
        const ct = await gQuery(`SELECT COUNT(DISTINCT movie_code)::int c FROM analytics_events
                                 WHERE event_type='download' AND created_at >= $1 AND created_at < $2`, [ts, tsEnd]);
        total = ct.rows[0].c;
        const r = await gQuery(`SELECT movie_code, COUNT(*)::int c FROM analytics_events
                                WHERE event_type='download' AND created_at >= $1 AND created_at < $2
                                GROUP BY movie_code ORDER BY c DESC, movie_code LIMIT $3 OFFSET $4`, [ts, tsEnd, PAGE, off]);
        const labels = await movieLabels(r.rows.map(x => x.movie_code));
        items = r.rows.map(x => ({ lab: labels[x.movie_code], sub: `📥 Bugun: <b>${fmt(x.c)}</b>` }));
    } else if (key === 'my') {
        title = '📅 KECHA TOP KINOLAR';
        const ct = await gQuery(`SELECT COUNT(DISTINCT movie_code)::int c FROM analytics_events
                                 WHERE event_type='download' AND created_at >= $1 AND created_at < $2`, [ys, ts]);
        total = ct.rows[0].c;
        const r = await gQuery(`SELECT movie_code, COUNT(*)::int c FROM analytics_events
                                WHERE event_type='download' AND created_at >= $1 AND created_at < $2
                                GROUP BY movie_code ORDER BY c DESC, movie_code LIMIT $3 OFFSET $4`, [ys, ts, PAGE, off]);
        const labels = await movieLabels(r.rows.map(x => x.movie_code));
        items = r.rows.map(x => ({ lab: labels[x.movie_code], sub: `📥 Kecha: <b>${fmt(x.c)}</b>` }));
    } else if (key === 'mg') {
        title = '📈 ENG TEZ O\'SAYOTGAN KINOLAR';
        const ct = await gQuery(`SELECT COUNT(DISTINCT movie_code)::int c FROM analytics_events
                                 WHERE event_type='download' AND created_at >= $1`, [ts]);
        total = ct.rows[0].c;
        const r = await gQuery(
            `SELECT movie_code,
                    COUNT(*) FILTER (WHERE created_at >= $1) AS today,
                    COUNT(*) FILTER (WHERE created_at >= $2 AND created_at < $1) AS yest
             FROM analytics_events
             WHERE event_type='download' AND created_at >= $2
             GROUP BY movie_code
             HAVING COUNT(*) FILTER (WHERE created_at >= $1) > 0
             ORDER BY today DESC, movie_code LIMIT $3 OFFSET $4`,
            [ts, ys, PAGE, off]);
        const labels = await movieLabels(r.rows.map(x => x.movie_code));
        items = r.rows.map(x => ({
            lab: labels[x.movie_code],
            sub: `Kecha: <b>${fmt(x.yest)}</b> → Bugun: <b>${fmt(x.today)}</b>  <b>${pct(x.today, x.yest)}</b>`
        }));
    }

    const lines = [
        title,
        total > 0 ? `Jami: ${fmt(total)} • Sahifa ${page} / ${Math.max(1, Math.ceil(total / PAGE))}` : '',
        ''
    ];
    if (items.length === 0) {
        lines.push('Hech qanday ma\'lumot yo\'q.');
    } else {
        items.forEach((it, i) => {
            lines.push(`${off + i + 1}. <b>${esc(cap(it.lab, 60))}</b>\n   ${it.sub}`);
        });
    }

    const kb = { inline_keyboard: [] };
    if (total > PAGE) {
        kb.inline_keyboard.push([
            b('⬅️', `st_pg_${key}_${page - 1}`),
            b(`📄 ${page}/${Math.ceil(total / PAGE)}`, `st_nav_${key}`),
            b('➡️', `st_pg_${key}_${page + 1}`)
        ]);
    }
    kb.inline_keyboard.push(backRow('st_movies'));

    return { text: lines.join('\n'), keyboard: kb };
}

// ====================================================================
// BUGUN / KECHA
// ====================================================================
async function dayPanel(kind) {
    const main = dayStart(kind === 'yest' ? 1 : 0);
    const mainEnd = new Date(main.getTime() + 86400000);
    const prev = new Date(main.getTime() - 86400000);
    const dayLabel = kind === 'yest' ? 'KECHA' : 'BUGUN';

    const [nu, dl, starts, nf, top, active] = await Promise.all([
        gQuery(`SELECT COUNT(*)::int c FROM users WHERE joined_at >= $1 AND joined_at < $2`, [main, mainEnd]),
        gQuery(`SELECT COUNT(*)::int c FROM analytics_events WHERE event_type='download' AND created_at >= $1 AND created_at < $2`, [main, mainEnd]),
        gQuery(`SELECT COUNT(*)::int c FROM analytics_events WHERE event_type='start' AND created_at >= $1 AND created_at < $2`, [main, mainEnd]),
        gQuery(`SELECT COUNT(*)::int c FROM analytics_events WHERE event_type='not_found' AND created_at >= $1 AND created_at < $2`, [main, mainEnd]),
        gQuery(`SELECT movie_code, COUNT(*)::int c FROM analytics_events
                WHERE event_type='download' AND created_at >= $1 AND created_at < $2
                GROUP BY movie_code ORDER BY c DESC LIMIT 5`, [main, mainEnd]),
        gQuery(`SELECT COUNT(DISTINCT user_id)::int c FROM analytics_events WHERE created_at >= $1 AND created_at < $2`, [main, mainEnd])
    ]);

    const nuPrev = (await gQuery('SELECT COUNT(*)::int c FROM users WHERE joined_at >= $1 AND joined_at < $2', [prev, main])).rows[0].c;
    const dlPrev = (await gQuery(`SELECT COUNT(*)::int c FROM analytics_events WHERE event_type='download' AND created_at >= $1 AND created_at < $2`, [prev, main])).rows[0].c;

    const labels = await movieLabels(top.rows.map(x => x.movie_code));

    const L = [];
    L.push(`📅 <b>${dayLabel}</b> (${fmtLocalLong(main)})`);
    L.push('');
    L.push(`🆕 Yangi userlar: <b>${fmt(nu.rows[0].c)}</b> ${pct(nu.rows[0].c, nuPrev)}`);
    L.push(`🔄 /start: <b>${fmt(starts.rows[0].c)}</b>`);
    L.push(`📥 Yuklab olishlar: <b>${fmt(dl.rows[0].c)}</b> ${pct(dl.rows[0].c, dlPrev)}`);
    L.push(`🔍 Topilmagan qidiruv: <b>${fmt(nf.rows[0].c)}</b>`);
    L.push(`🟢 Faol userlar: <b>${fmt(active.rows[0].c)}</b>`);
    L.push('');
    L.push(`${kind === 'yest' ? '📅' : '🔥'} Eng ko\'p yuklangan:`);
    if (top.rows.length === 0) {
        L.push('Ma\'lumot yo\'q');
    } else {
        top.rows.forEach((x, i) => L.push(`${i + 1}. ${esc(cap(labels[x.movie_code], 55))} — 📥 <b>${fmt(x.c)}</b>`));
    }

    return { text: L.join('\n'), keyboard: { inline_keyboard: [backRow('st_menu')] } };
}

// ====================================================================
// FOYDALANUVCHILAR PANELI
// ====================================================================
async function usersPanel() {
    const ts = dayStart(0);
    const ws = dayStart(7);
    const ms = dayStart(30);

    const [total, nu, act, dlUsers, srchUsers, starts, blocked] = await Promise.all([
        gQuery('SELECT COUNT(*)::int c FROM users'),
        gQuery(`SELECT COUNT(*) FILTER (WHERE joined_at >= $1) AS today,
                       COUNT(*) FILTER (WHERE joined_at >= $2 AND joined_at < $1) AS yest,
                       COUNT(*) FILTER (WHERE joined_at >= $3) AS week,
                       COUNT(*) FILTER (WHERE joined_at >= $4) AS month
                FROM users WHERE joined_at >= $4`, [ts, dayStart(1), ws, ms]),
        gQuery(`SELECT COUNT(DISTINCT user_id) FILTER (WHERE created_at >= $1) AS today,
                       COUNT(DISTINCT user_id) FILTER (WHERE created_at >= $2) AS w7,
                       COUNT(DISTINCT user_id) FILTER (WHERE created_at >= $3) AS m30
                FROM analytics_events WHERE created_at >= $3`, [ts, ws, ms]),
        gQuery(`SELECT COUNT(DISTINCT user_id)::int c FROM analytics_events WHERE event_type='download' AND created_at >= $1`, [ts]),
        gQuery(`SELECT COUNT(DISTINCT user_id)::int c FROM analytics_events WHERE event_type IN ('download','not_found') AND created_at >= $1`, [ts]),
        gQuery(`SELECT COUNT(*)::int c FROM analytics_events WHERE event_type='start' AND created_at >= $1`, [ts]),
        gQuery('SELECT COUNT(*)::int c FROM blocked_users')
    ]);

    const L = [];
    L.push('👥 <b>FOYDALANUVCHILAR</b>');
    L.push('');
    L.push(`Jami foydalanuvchilar: <b>${fmt(total.rows[0].c)}</b>`);
    L.push('');
    L.push(`🆕 Yangi qo\'shilganlar:`);
    L.push(`  Bugun: <b>${fmt(nu.rows[0].today)}</b>`);
    L.push(`  Kecha: <b>${fmt(nu.rows[0].yest)}</b>`);
    L.push(`  Haftalik: <b>${fmt(nu.rows[0].week)}</b>`);
    L.push(`  Oylik: <b>${fmt(nu.rows[0].month)}</b>`);
    L.push('');
    L.push(`🟢 Faollik (no\'yob):`);
    L.push(`  Bugun: <b>${fmt(act.rows[0].today)}</b>`);
    L.push(`  7 kun: <b>${fmt(act.rows[0].w7)}</b>`);
    L.push(`  30 kun: <b>${fmt(act.rows[0].m30)}</b>`);
    L.push('');
    L.push(`📥 Bugun kino olgan: <b>${fmt(dlUsers.rows[0].c)}</b>`);
    L.push(`🔍 Bugun kino qidirgan: <b>${fmt(srchUsers.rows[0].c)}</b>`);
    L.push(`🔄 /start bugun: <b>${fmt(starts.rows[0].c)}</b>`);
    L.push(`🚫 Bloklagan: <b>${fmt(blocked.rows[0].c)}</b>`);

    return { text: L.join('\n'), keyboard: { inline_keyboard: [backRow('st_menu')] } };
}

// ====================================================================
// SOATLIK FAOLLIK
// ====================================================================
async function hourlyPanel() {
    const ts = dayStart(0);
    const tsEnd = new Date(ts.getTime() + 86400000);
    const r = await gQuery(
        `SELECT EXTRACT(HOUR FROM created_at AT TIME ZONE 'Asia/Tashkent')::int AS h,
                COUNT(DISTINCT user_id)::int AS users,
                COUNT(*) FILTER (WHERE event_type='download')::int AS dls,
                COUNT(*) FILTER (WHERE event_type='start')::int AS starts
         FROM analytics_events WHERE created_at >= $1 AND created_at < $2
         GROUP BY h ORDER BY h`, [ts, tsEnd]);

    const M = {};
    for (const row of r.rows) M[row.h] = row;

    const L = [`⏰ <b>BUGUNGI SOATLIK FAOLLIK</b>`, ''];
    for (let h = 0; h < 24; h++) {
        const x = M[h];
        L.push(`${String(h).padStart(2, '0')}:00 — ${x
            ? `👥 ${fmt(x.users)} 📥 ${fmt(x.dls)} 🚀 ${fmt(x.starts)}`
            : '·'}`);
    }
    return { text: L.join('\n'), keyboard: { inline_keyboard: [backRow('st_menu')] } };
}

// ====================================================================
// KUNLIK (7/14/30/90/barcha)
// ====================================================================
function buildGrid(days) {
    const grid = [];
    const today = dayStart(0);
    for (let i = 0; i < days; i++) {
        const d = new Date(today.getTime() - i * 86400000);
        grid.push(tzDateStr(d));
    }
    return grid;
}

async function dailyPanel(days) {
    const unlimited = days === 0;
    const limit = unlimited ? 30 : days;
    const start = dayStart(limit);
    const grid = buildGrid(limit);

    const [nuByDay, evByDay] = await Promise.all([
        gQuery(`SELECT (joined_at AT TIME ZONE 'Asia/Tashkent')::date::text AS d, COUNT(*)::int c
                FROM users WHERE joined_at >= $1 GROUP BY d`, [start]),
        gQuery(`SELECT (created_at AT TIME ZONE 'Asia/Tashkent')::date::text AS d,
                       COUNT(DISTINCT user_id)::int AS active,
                       COUNT(*) FILTER (WHERE event_type='start')::int AS starts,
                       COUNT(*) FILTER (WHERE event_type='download')::int AS dls,
                       COUNT(*) FILTER (WHERE event_type='not_found')::int AS nf
                FROM analytics_events WHERE created_at >= $1 GROUP BY d`, [start])
    ]);
    const nm = {}; nuByDay.rows.forEach(x => nm[String(x.d)] = x.c);
    const em = {}; evByDay.rows.forEach(x => em[String(x.d)] = x);

    const L = [unlimited ? `📅 <b>KUNLIK (so'nggi ${limit} kun)</b>` : `📅 <b>SO\'NGGI ${limit} KUN</b>`, ''];
    for (const d of grid) {
        const nu = nm[d] || 0;
        const ev = em[d];
        if (nu === 0 && !ev) continue;
        const dp = d.slice(5).split('-').reverse().join('.');
        const parts = [`<b>${dp}</b>`];
        if (nu) parts.push(`+${fmt(nu)} uy`);
        if (ev) {
            if (ev.active) parts.push(`faol ${ev.active}`);
            if (ev.dls) parts.push(`📥 ${ev.dls}`);
            if (ev.starts) parts.push(`🚀 ${ev.starts}`);
            if (ev.nf) parts.push(`🔍0 ${ev.nf}`);
        }
        L.push(parts.join(' · '));
    }
    if (L.length === 2) L.push('Ma\'lumot yo\'q.');
    L.push('');
    L.push('uy=user · faol=no\'yob faol userlar');
    return { text: L.join('\n'), keyboard: { inline_keyboard: [backRow('st_daily')] } };
}

// ====================================================================
// USER O'SISHI
// ====================================================================
async function growthPanel() {
    const ts = dayStart(0);
    const ws = dayStart(7);
    const prevWs = dayStart(14);
    const ms = dayStart(30);
    const prevMs = dayStart(60);

    const [week, month, grid] = await Promise.all([
        gQuery(`SELECT COUNT(*) FILTER (WHERE joined_at >= $1) AS cur,
                       COUNT(*) FILTER (WHERE joined_at >= $2 AND joined_at < $1) AS prev
                FROM users WHERE joined_at >= $2`, [ws, prevWs]),
        gQuery(`SELECT COUNT(*) FILTER (WHERE joined_at >= $1) AS cur,
                       COUNT(*) FILTER (WHERE joined_at >= $2 AND joined_at < $1) AS prev
                FROM users WHERE joined_at >= $2`, [ms, prevMs]),
        gQuery(`SELECT (joined_at AT TIME ZONE 'Asia/Tashkent')::date::text AS d, COUNT(*)::int c
                FROM users WHERE joined_at >= $1 GROUP BY d`, [dayStart(14)])
    ]);

    const nm = {}; grid.rows.forEach(x => nm[String(x.d)] = x.c);

    const L = [`📈 <b>USER O\'SISHI</b>`, ''];
    L.push(`Haftalik (7 kun): <b>${fmt(week.rows[0].cur)}</b>  (o\'tgan hafta: ${week.rows[0].prev}) ${pct(week.rows[0].cur, week.rows[0].prev)}`);
    L.push(`Oylik (30 kun): <b>${fmt(month.rows[0].cur)}</b>  (o\'tgan oy: ${month.rows[0].prev}) ${pct(month.rows[0].cur, month.rows[0].prev)}`);
    L.push('');
    L.push('So\'nggi 14 kun (kunlik yangi userlar):');
    const today0 = dayStart(0).getTime();
    for (let i = 13; i >= 0; i--) {
        const d = tzDateStr(new Date(today0 - i * 86400000));
        const c = nm[d] || 0;
        if (c === 0) continue;
        L.push(`${d.slice(5).split('-').reverse().join('.')} — <b>+${fmt(c)}</b>`);
    }
    if (L[L.length - 1] === 'So\'nggi 14 kun (kunlik yangi userlar):') L.push('Ma\'lumot yo\'q.');
    return { text: L.join('\n'), keyboard: { inline_keyboard: [backRow('st_menu')] } };
}

// ====================================================================
// QIDIRUV / TOPILMAGAN
// ====================================================================
async function searchPanel() {
    const ts = dayStart(0);
    const tsEnd = new Date(ts.getTime() + 86400000);

    const [total, today, nfToday, nfAll, topSearch, topNf] = await Promise.all([
        gQuery(`SELECT COUNT(*)::int c FROM analytics_events WHERE event_type='download'`),
        gQuery(`SELECT COUNT(*) FILTER (WHERE event_type='download') AS dl,
                       COUNT(*) FILTER (WHERE event_type='not_found') AS nf
                FROM analytics_events WHERE created_at >= $1 AND created_at < $2`, [ts, tsEnd]),
        gQuery(`SELECT COUNT(DISTINCT user_id)::int c FROM analytics_events
                WHERE event_type='not_found' AND created_at >= $1 AND created_at < $2`, [ts, tsEnd]),
        gQuery(`SELECT COUNT(*)::int c FROM analytics_events WHERE event_type='not_found'`),
        gQuery(`SELECT movie_code, COUNT(*)::int c FROM analytics_events
                WHERE event_type='download' AND created_at >= $1 AND created_at < $2
                GROUP BY movie_code ORDER BY c DESC LIMIT 5`, [ts, tsEnd]),
        gQuery(`SELECT payload, COUNT(*)::int c FROM analytics_events
                WHERE event_type='not_found' AND created_at >= $1 AND created_at < $2
                GROUP BY payload ORDER BY c DESC LIMIT 10`, [ts, tsEnd])
    ]);

    const labels = await movieLabels(topSearch.rows.map(x => x.movie_code));

    const L = [`🔍 <b>QIDIRUV STATISTIKASI</b>`, ''];
    L.push(`📥 Umumiy yuklab olishlar: <b>${fmt(total.rows[0].c)}</b>`);
    L.push('');
    L.push('📅 <b>BUGUN</b>');
    L.push(`  🎬 Muvaffaqiyatli: <b>${fmt(today.rows[0].dl)}</b>`);
    L.push(`  ❌ Topilmagan: <b>${fmt(today.rows[0].nf)}</b> (${fmt(nfToday.rows[0].c)} user)`);
    L.push(`  🔄 Jami so\'rovlar: <b>${fmt(today.rows[0].dl + today.rows[0].nf)}</b>`);
    L.push('');
    L.push('📚 <b>Bugun eng ko\'p qidirilgan kinolar:</b>');
    if (topSearch.rows.length === 0) L.push('Ma\'lumot yo\'q');
    else topSearch.rows.forEach((x, i) => L.push(`${i + 1}. ${esc(cap(labels[x.movie_code], 55))} — 📥 <b>${fmt(x.c)}</b>`));
    L.push('');
    L.push('❌ <b>Bugun topilmagan so\'rovlar:</b>');
    if (topNf.rows.length === 0) L.push('Ma\'lumot yo\'q');
    else topNf.rows.forEach((x, i) => L.push(`${i + 1}. "${esc(x.payload)}" — <b>${fmt(x.c)}</b>`));
    L.push('');
    L.push(`🗂 Barcha topilmaganlar (butun davr): <b>${fmt(nfAll.rows[0].c)}</b>`);

    return { text: L.join('\n'), keyboard: { inline_keyboard: [backRow('st_menu')] } };
}

// ====================================================================
// BLOKLAGANLAR
// ====================================================================
async function blockedPanel(page) {
    page = Math.max(1, Number(page) || 1);
    const off = (page - 1) * PAGE;
    const [cnt, rows] = await Promise.all([
        gQuery('SELECT COUNT(*)::int c FROM blocked_users'),
        gQuery('SELECT chat_id, first_seen_at FROM blocked_users ORDER BY first_seen_at DESC LIMIT $1 OFFSET $2', [PAGE, off])
    ]);
    const total = cnt.rows[0].c;

    const L = [`🚫 <b>BLOKLAGAN FOYDALANUVCHILAR</b>`, `Jami: <b>${fmt(total)}</b>`, ''];
    if (rows.rows.length === 0) L.push('Hozircha bloklaganlar yo\'q.');
    else rows.rows.forEach((x, i) => L.push(`${off + i + 1}. <code>${x.chat_id}</code>`));

    const kb = { inline_keyboard: [] };
    if (total > PAGE) kb.inline_keyboard.push([
        b('⬅️ Avvalgi', `st_pg_bl_${page - 1}`),
        b('➡️ Keyingi', `st_pg_bl_${page + 1}`)
    ]);
    kb.inline_keyboard.push(backRow('st_menu'));
    return { text: L.join('\n'), keyboard: kb };
}

// ====================================================================
// CSV EXPORT
// ====================================================================
async function buildExportCsv() {
    const start = dayStart(30);
    const [evByDay, nuByDay, movies] = await Promise.all([
        gQuery(`SELECT (created_at AT TIME ZONE 'Asia/Tashkent')::date::text AS d,
                       COUNT(DISTINCT user_id)::int AS active,
                       COUNT(*) FILTER (WHERE event_type='download')::int AS dls,
                       COUNT(*) FILTER (WHERE event_type='start')::int AS starts,
                       COUNT(*) FILTER (WHERE event_type='not_found')::int AS nf
                FROM analytics_events WHERE created_at >= $1 GROUP BY d ORDER BY d`, [start]),
        gQuery(`SELECT (joined_at AT TIME ZONE 'Asia/Tashkent')::date::text AS d, COUNT(*)::int c
                FROM users WHERE joined_at >= $1 GROUP BY d ORDER BY d`, [start]),
        gQuery('SELECT code, caption, views FROM movies ORDER BY views DESC, code')
    ]);

    const nm = {}; nuByDay.rows.forEach(x => nm[String(x.d)] = x.c);
    const R = [];
    R.push('Sana;Yangi userlar;Faol userlar;Downloadlar;/start;Topilmagan');
    for (const d of evByDay.rows) {
        R.push(`${d.d};${nm[String(d.d)] || 0};${d.active};${d.dls};${d.starts};${d.nf}`);
    }
    R.push('');
    R.push('Kod;Nomi;Jami yuklab olishlar');
    for (const m of movies.rows) {
        R.push(`${m.code};${(m.caption || '').replace(/;/g, ' ').replace(/\n/g, ' ')};${m.views}`);
    }
    return R.join('\r\n');
}

// ====================================================================
// AVTOMATIK KUNLIK HISOBOT (00:00-00:10 Tashkent)
// ====================================================================
async function reportFor(dayLabel) {
    const st = new Date(dayLabel + 'T00:00:00+05:00');
    const en = new Date(st.getTime() + 86400000);
    const prev = new Date(st.getTime() - 86400000);

    const [nu, dl, starts, nf, active, top, nuPrev, dlPrev] = await Promise.all([
        gQuery('SELECT COUNT(*)::int c FROM users WHERE joined_at >= $1 AND joined_at < $2', [st, en]),
        gQuery(`SELECT COUNT(*)::int c FROM analytics_events WHERE event_type='download' AND created_at >= $1 AND created_at < $2`, [st, en]),
        gQuery(`SELECT COUNT(*)::int c FROM analytics_events WHERE event_type='start' AND created_at >= $1 AND created_at < $2`, [st, en]),
        gQuery(`SELECT COUNT(*)::int c FROM analytics_events WHERE event_type='not_found' AND created_at >= $1 AND created_at < $2`, [st, en]),
        gQuery(`SELECT COUNT(DISTINCT user_id)::int c FROM analytics_events WHERE created_at >= $1 AND created_at < $2`, [st, en]),
        gQuery(`SELECT movie_code, COUNT(*)::int c FROM analytics_events
                WHERE event_type='download' AND created_at >= $1 AND created_at < $2
                GROUP BY movie_code ORDER BY c DESC LIMIT 5`, [st, en]),
        gQuery('SELECT COUNT(*)::int c FROM users WHERE joined_at >= $1 AND joined_at < $2', [prev, st]),
        gQuery(`SELECT COUNT(*)::int c FROM analytics_events WHERE event_type='download' AND created_at >= $1 AND created_at < $2`, [prev, st])
    ]);

    const d = new Intl.DateTimeFormat('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' }).format(st);
    const labels = await movieLabels(top.rows.map(x => x.movie_code));

    let T = `📊 <b>KUNLIK HISOBOT</b> — ${d}\n\n`;
    T += `👥 Yangi userlar: <b>${fmt(nu.rows[0].c)}</b> (${pct(nu.rows[0].c, nuPrev.rows[0].c)})\n`;
    T += `🔄 /start: <b>${fmt(starts.rows[0].c)}</b>\n`;
    T += `📥 Downloadlar: <b>${fmt(dl.rows[0].c)}</b> (${pct(dl.rows[0].c, dlPrev.rows[0].c)})\n`;
    T += `🔍 Topilmagan: <b>${fmt(nf.rows[0].c)}</b>\n`;
    T += `🟢 Faol: <b>${fmt(active.rows[0].c)}</b>\n\n`;
    T += `🔥 <b>TOP 5:</b>\n`;
    if (top.rows.length === 0) T += 'Ma\'lumot yo\'q\n';
    else top.rows.forEach((x, i) => T += `${i + 1}. ${esc(cap(labels[x.movie_code], 55))} — 📥 <b>${fmt(x.c)}</b>\n`);

    try {
        await gBot.sendMessage(gAdminId, T, { parse_mode: 'HTML' });
    } catch (e) {
        console.error('Kunlik report yuborish xato:', e && e.message);
    }
}

function startDailyReport() {
    setInterval(async () => {
        try {
            if (!gQuery) return;
            const hm = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
            const [hh, mm] = hm.split(':').map(Number);
            if (hh !== 0 || mm > 10) return;
            const yest = dayStart(1);
            const yestKey = tzDateStr(yest);
            const done = await gQuery("SELECT value FROM app_settings WHERE key = 'last_report'").catch(() => ({ rows: [] }));
            if (done.rows[0] && done.rows[0].value === yestKey) return;
            await reportFor(yestKey);
            await gQuery("INSERT INTO app_settings (key, value) VALUES ('last_report', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [yestKey]).catch(() => {});
        } catch (e) {
            console.error('Kunlik report xato:', e && e.message);
        }
    }, 30000);
}

// ====================================================================
// ADMIN STATISTIKA MENYUSI
// ====================================================================
async function openStats(chatId) {
    try {
        const text = await dashboard();
        await gBot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: mainMenu() });
    } catch (e) {
        console.error('Statistika ochish xato:', e && e.message);
    }
}

// ---------- callback dispatcher ----------
async function handleStatsCallback(data, chatId, query) {
    try {
        if (data === 'st_dash' || data === 'st_refresh') {
            const text = await dashboard();
            await gBot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: mainMenu() });
            return true;
        }
        if (data === 'st_menu') {
            const text = await dashboard();
            await gBot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: mainMenu() });
            return true;
        }
        if (data === 'st_today' || data === 'st_yest') {
            const p = await dayPanel(data === 'st_yest' ? 'yest' : 'today');
            await gBot.sendMessage(chatId, p.text, { parse_mode: 'HTML', reply_markup: p.keyboard });
            return true;
        }
        if (data === 'st_movies') {
            await gBot.sendMessage(chatId, '🎬 <b>KINOLAR STATISTIKASI</b>\n\nBo\'limni tanlang:', { parse_mode: 'HTML', reply_markup: moviesMenu() });
            return true;
        }
        if (data === 'st_users') {
            const p = await usersPanel();
            await gBot.sendMessage(chatId, p.text, { parse_mode: 'HTML', reply_markup: p.keyboard });
            return true;
        }
        if (data === 'st_hourly') {
            const p = await hourlyPanel();
            await gBot.sendMessage(chatId, p.text, { parse_mode: 'HTML', reply_markup: p.keyboard });
            return true;
        }
        if (data === 'st_growth') {
            const p = await growthPanel();
            await gBot.sendMessage(chatId, p.text, { parse_mode: 'HTML', reply_markup: p.keyboard });
            return true;
        }
        if (data === 'st_daily') {
            await gBot.sendMessage(chatId, '📅 <b>KUNLIK STATISTIKA</b>\n\nOraliqni tanlang:', { parse_mode: 'HTML', reply_markup: dailyMenu() });
            return true;
        }
        if (/^st_dr_(\d+)$/.test(data)) {
            const days = parseInt(data.split('_')[2], 10);
            const p = await dailyPanel(days);
            await gBot.sendMessage(chatId, p.text, { parse_mode: 'HTML', reply_markup: p.keyboard });
            return true;
        }
        if (data === 'st_search') {
            const p = await searchPanel();
            await gBot.sendMessage(chatId, p.text, { parse_mode: 'HTML', reply_markup: p.keyboard });
            return true;
        }
        if (data === 'st_blocked') {
            const p = await blockedPanel(1);
            await gBot.sendMessage(chatId, p.text, { parse_mode: 'HTML', reply_markup: p.keyboard });
            return true;
        }
        if (/^st_pg_/.test(data)) {
            const parts = data.split('_'); // st, pg, <key>, <page>
            const key = parts[2];
            const page = parseInt(parts[3], 10);
            let p;
            if (key === 'bl') p = await blockedPanel(page);
            else p = await renderTopList(key, page);
            await gBot.sendMessage(chatId, p.text, { parse_mode: 'HTML', reply_markup: p.keyboard });
            return true;
        }
        if (/^st_m_/.test(data)) {
            const keyMap = { today: 'mt', yest: 'my', growth: 'mg', all: 'ma' };
            const key = keyMap[data.split('_')[2]] || 'mt';
            const p = await renderTopList(key, 1);
            await gBot.sendMessage(chatId, p.text, { parse_mode: 'HTML', reply_markup: p.keyboard });
            return true;
        }
        if (/^st_nav_/.test(data)) {
            const keyMap = { mt: 'mt', my: 'my', mg: 'mg', ma: 'ma' };
            const key = keyMap[data.split('_')[2]] || 'mt';
            const p = await renderTopList(key, 1);
            await gBot.sendMessage(chatId, p.text, { parse_mode: 'HTML', reply_markup: p.keyboard });
            return true;
        }
        if (data === 'st_export') {
            await gBot.answerCallbackQuery(query.id, { text: '⏳ CSV tayyorlanmoqda...' });
            const csv = await buildExportCsv();
            await gBot.sendDocument(chatId, Buffer.from(csv, 'utf8'), { filename: `kinobot_statistika_${tzDateStr(new Date())}.csv` });
            await gBot.sendMessage(chatId, '📥 CSV yuborildi.', { reply_markup: mainMenu() });
            return true;
        }
        return false;
    } catch (e) {
        console.error('Statistika callback xato:', e && e.message);
        try { await gBot.sendMessage(chatId, '❌ Statistika ishlovida xato yuz berdi.', { reply_markup: mainMenu() }); } catch (e2) {}
        return true;
    }
}

module.exports = {
    init,
    trackEvent,
    trackBlocked,
    openStats,
    handleStatsCallback,
    startDailyReport,
    panels: {
        dashboard,
        dayPanel,
        usersPanel,
        growthPanel,
        hourlyPanel,
        dailyPanel,
        searchPanel,
        blockedPanel,
        renderTopList,
        buildExportCsv,
        reportFor
    },
    helpers: { fmt, pct, dayStart, tzDateStr },
    TZ
};