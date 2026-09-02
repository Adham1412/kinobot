require('dotenv').config();
const fs = require('fs');
const path = require('path');
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const express = require('express');

// --- SOZLAMALAR ---
const token = process.env.BOT_TOKEN;
const adminId = parseInt(process.env.ADMIN_ID);
const dbChannelId = process.env.DB_CHANNEL_ID;

// --- POSTGRESQL BAZA ---
const dbUrl = process.env.DATABASE_URL;
const dbParts = new URL(dbUrl);
const pool = new Pool({
    host: dbParts.hostname,
    port: parseInt(dbParts.port || '5432'),
    database: dbParts.pathname.replace(/^\//, ''),
    user: decodeURIComponent(dbParts.username),
    password: decodeURIComponent(dbParts.password),
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
});
const pgConnected = { ok: false };
pool.on('error', (e) => console.error('PG pool xato:', e.message));
async function pgQuery(text, params) {
    return await pool.query(text, params);
}
async function waitDB() {
    try {
        await pool.query('SELECT 1');
        pgConnected.ok = true;
        console.log('PostgreSQL ulandi');
    } catch (e) {
        pgConnected.ok = false;
        console.error('PostgreSQL ulanishda xato:', e.message);
        setTimeout(waitDB, 5000);
    }
}
const dbReady = () => pgConnected.ok;

// --- YAGONA NUSXA TEKSHIRUVI (ikkita bot bir token bilan ishlamasin) ---
const lockFile = path.join(__dirname, '.bot.pid');
try {
    const oldPid = parseInt(fs.readFileSync(lockFile, 'utf8'), 10);
    if (oldPid) {
        try {
            process.kill(oldPid, 0);
            console.log('!!! Bot allaqachon ishlayapti (PID ' + oldPid + '). Ikkinchi nusxa qo\'zg\'atilmaydi.');
            process.exit(1);
        } catch (e) { /* eski jarayon o'chgan */ }
    }
} catch (e) { /* lock fayl yo'q */ }
fs.writeFileSync(lockFile, String(process.pid));
const removeLock = () => { try { fs.unlinkSync(lockFile); } catch (e) {} };
process.on('exit', removeLock);
process.on('SIGINT', () => { removeLock(); process.exit(0); });
process.on('SIGTERM', () => { removeLock(); process.exit(0); });

// --- SERVER ---
const app = express();
app.get('/', (req, res) => res.send('Bot faol va ishlamoqda!'));
app.listen(process.env.PORT || 3000, () => console.log('Server ishladi'));

// --- BOT ---
const bot = new TelegramBot(token, { polling: true });
let botUsername = null;
async function getBotUsername() {
    if (!botUsername) {
        try { botUsername = (await bot.getMe()).username; } catch (e) {}
    }
    return botUsername;
}

// Hech qanday xato botni o'ldirmasligi uchun himoya
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e && e.message || e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e && e.message || e));

// --- POSTGRESQL ULANISH ---
waitDB();
setInterval(updateBotBio, 3600 * 1000);

async function updateBotBio() {
    try {
        if (!dbReady()) return;
        const u = await pgQuery('SELECT COUNT(*)::int AS c FROM users');
        const m = await pgQuery('SELECT COUNT(*)::int AS c FROM movies');
        await bot.setMyShortDescription({
            short_description: `🎬 Kino kodini yuboring!\n\n👥 ${u.rows[0].c} | 💿 ${m.rows[0].c}`
        });
    } catch (e) { console.error('Bio xato:', e.message); }
}

// --- ADMIN HOLATI ---
const adminState = new Map();
const pendingMovies = new Map();

const adminKeyboard = {
    reply_markup: {
        keyboard: [
            ['🎬 Kino Yuklash', "🗑 Kino O'chirish"],
            ['📊 Statistika', '📢 Reklama Tarqatish'],
            ['📢 Kanallar Sozlamasi']
        ],
        resize_keyboard: true
    }
};

const cancelKeyboard = {
    reply_markup: {
        keyboard: [['🚫 Bekor qilish']],
        resize_keyboard: true
    }
};

// --- OBUNA TEKSHIRUVLARI ---
async function getMissingChannels(chatId) {
    if (chatId === adminId) return [];
    const r = await pgQuery('SELECT * FROM sponsor_channels');
    const channels = r.rows;
    const missing = [];
    for (const ch of channels) {
        let isSub = false;
        try {
            const m = await bot.getChatMember(ch.channel_id, chatId);
            isSub = !['left', 'kicked'].includes(m.status);
        } catch (e) {
            console.log('Kanal xato:', ch.name, e.message);
        }
        if (!isSub) missing.push(ch);
    }
    return missing;
}

function buildSubKeyboard(channels) {
    const rows = channels.map((ch, i) => [
        { text: `${i + 1}-obuna`, url: ch.link }
    ]);
    rows.push([{ text: '✅ Tekshirish', callback_data: 'check_sub' }]);
    return { inline_keyboard: rows };
}

// --- KINO YUBORISH ---
async function cleanupMovie(movieId) {
    try {
        const m = await pgQuery('SELECT code FROM movies WHERE id = $1', [movieId]);
        if (m.rows[0]) await pgQuery('DELETE FROM delivered_movies WHERE movie_code = $1', [m.rows[0].code]);
        await pgQuery('DELETE FROM movies WHERE id = $1', [movieId]);
    } catch (e) { console.error(e); }
}

async function sendMovie(chatId, movieId) {
    try {
        const updRes = await pgQuery('UPDATE movies SET views = views + 1 WHERE id = $1 RETURNING *', [movieId]);
        const upd = updRes.rows[0];
        if (!upd) return false;
        const isUser = chatId !== adminId;
        const sentMsg = await bot.sendVideo(chatId, upd.file_id, {
            caption: `🎬 <b>${upd.caption}</b>\n\n👁 Ko'rishlar: ${upd.views}\n🤖 Bot: @${await getBotUsername()}`,
            parse_mode: 'HTML',
            ...(isUser ? { protect_content: true } : {})
        });
        if (isUser) {
            try {
                await pgQuery('INSERT INTO delivered_movies (chat_id, message_id, movie_code) VALUES ($1,$2,$3)', [chatId, sentMsg.message_id, upd.code]);
            } catch (e) {}
        }
        return true;
    } catch (e) {
        // Kino yuborilmadi. Fayl CHINDAKAM o'chirilganligi aniq bo'lsa — bazadan o'chiramiz.
        // Aks holda (katta fayl, flood va h.k.) kino O'CHIRILMAYDI, faqat xato xabar yuboriladi.
        let deleted = false;
        if (upd) {
            try {
                await bot.getFile(upd.file_id);
            } catch (e2) {
                const m = (e2.message || '').toLowerCase();
                deleted = !m.includes('too big') && !m.includes('flood');
            }
        }
        if (upd && deleted) {
            await cleanupMovie(upd.id);
            bot.sendMessage(chatId, '❌ Bu kod bekor qilingan');
        } else {
            bot.sendMessage(chatId, '❌ Kino uzilmayapti');
        }
        return false;
    }
}

// --- KANALDA YO'QOLGAN KINOLARNI AVTO-SKANER QILISH O'CHIRILDI ---
// Eslatma: getFile tekshiruvi katta/uzoq saqlanadigan video uchun xato qaytarishi
// mumkin, bu esa to'g'ri kinolarni bazadan o'chirib yuborardi. Shu uchun olib tashlandi.
// Endi kino bazadan faqat admin qo'lda (admin panel) yoki sendVideo aniq xato bersa chiqariladi.

async function finishSubscription(chatId, msgId, queryId) {
    try { if (queryId) await bot.answerCallbackQuery(queryId, { text: '✅' }); } catch (e) {}
    try { await bot.deleteMessage(chatId, msgId); } catch (e) {}
    const pend = pendingMovies.get(chatId);
    if (pend) {
        pendingMovies.delete(chatId);
        const m = await pgQuery('SELECT * FROM movies WHERE code = $1', [pend.code]);
        if (m.rows[0]) await sendMovie(chatId, m.rows[0].id);
    } else {
        bot.sendMessage(chatId, '✅');
    }
}

// --- OBUNA AVTO-YANGILANISHI (hech narsa bosmasdan tugmalar o'zi o'chadi) ---
let refreshing = false;
async function refreshPendingSubs() {
    if (refreshing) return;
    if (pendingMovies.size === 0) return;
    if (!dbReady()) return;
    refreshing = true;
    try {
        for (const [chatId, pend] of pendingMovies) {
            const missing = await getMissingChannels(chatId);
            if (missing.length === 0) {
                // Hammasiga a'zo bo'ldi — kino avto yuboriladi, tugmalar o'chadi
                if (pendingMovies.get(chatId) === pend) pendingMovies.delete(chatId);
                try { await bot.deleteMessage(chatId, pend.msgId); } catch (e) {}
                const m = await pgQuery('SELECT * FROM movies WHERE code = $1', [pend.code]);
                if (m.rows[0]) await sendMovie(chatId, m.rows[0].id);
            } else {
                // Yangi holat: chiqib ketgan bo'lsa tugma qaytadi, a'zo bo'lgan bo'lsa yo'qoladi
                try {
                    await bot.editMessageReplyMarkup(buildSubKeyboard(missing), {
                        chat_id: chatId,
                        message_id: pend.msgId
                    });
                } catch (e) {}
            }
            await new Promise(r => setTimeout(r, 700));
        }
    } finally {
        refreshing = false;
    }
}
setInterval(refreshPendingSubs, 5000);

// --- YUBORILGAN KINOLARNI TEKSHIRISH (OBUNA BUZILSA — KINO O'CHIRILADI, OBUNA TUGMASI QAYTADI) ---
async function revokeDeliveredForChat(chatId) {
    try {
        const r = await pgQuery('SELECT * FROM delivered_movies WHERE chat_id = $1', [chatId]);
        const entries = r.rows;
        if (entries.length === 0) return;
        for (const entry of entries) {
            try { await bot.deleteMessage(chatId, entry.message_id); } catch (e) {}
        }
        const missing = await getMissingChannels(chatId);
        const sent = await bot.sendMessage(chatId, '⚠️ Kanal obunasi buzildi! Kinoni olish uchun quyidagi kanalga obuna bo\'ling:', {
            reply_markup: buildSubKeyboard(missing)
        });
        const lastCode = entries[entries.length - 1].movie_code;
        pendingMovies.set(chatId, { code: lastCode, msgId: sent.message_id });
        await pgQuery('DELETE FROM delivered_movies WHERE chat_id = $1', [chatId]);
    } catch (e) { console.error('Delivered revoke xato:', e && e.message); }
}
async function checkAllDelivered() {
    if (!dbReady()) return;
    try {
        const r = await pgQuery('SELECT * FROM delivered_movies');
        const chatIds = [...new Set(r.rows.map(d => d.chat_id))];
        for (const chatId of chatIds) {
            const missing = await getMissingChannels(chatId);
            if (missing.length > 0) await revokeDeliveredForChat(chatId);
        }
    } catch (e) { console.error('Check delivered xato:', e && e.message); }
}
setInterval(checkAllDelivered, 20 * 1000);

// --- MESSAGE HANDLER ---
bot.on('message', (msg) => {
    (async () => {
    const chatType = msg.chat.type;

    // Guruh/superguruhda "kirdi/chiqdi" xizmat xabarlarini avto o'chirish
    if (chatType === 'supergroup' || chatType === 'group') {
        if (msg.new_chat_members || msg.left_chat_member) {
            try { await bot.deleteMessage(msg.chat.id, msg.message_id); } catch (e) {}
        }
        return;
    }

    if (chatType !== 'private') return;
    console.log('msg', msg.chat.id, msg.text);

    const chatId = msg.chat.id;
    const text = msg.text;
    const video = msg.video;

    // Foydalanuvchini saqlash (baza ulanganda)
    if (dbReady()) {
        try {
            const exists = await pgQuery('SELECT 1 FROM users WHERE chat_id = $1', [chatId]);
            if (!exists.rows[0]) {
                await pgQuery('INSERT INTO users (chat_id, first_name) VALUES ($1,$2)', [chatId, msg.chat.first_name || null]);
            }
        } catch (e) { console.error(e); }
    }

    // --- ADMIN ---
    if (chatId === adminId) {
        if (text === '🚫 Bekor qilish' || text === '/cancel') {
            adminState.delete(chatId);
            return bot.sendMessage(chatId, '❌ Bekor qilindi.', adminKeyboard);
        }

        const state = adminState.get(chatId);
        const adminCmds = ['/start', '/panel', '🎬 Kino Yuklash', "🗑 Kino O'chirish", '📊 Statistika', '📢 Reklama Tarqatish', '📢 Kanallar Sozlamasi'];
        const isAdminCmd = text && adminCmds.includes(String(text).trim());

        // Admin kutish holatida (video/kod/reklama kutayotganda) boshqa panel tugmasini bossa —
        // tugma matnini kutilayotgan xabar sifatida qabul qilmaymiz, o'sha tugma vazifasiga o'tamiz.
        if (state && isAdminCmd) adminState.delete(chatId);

        if (state && !isAdminCmd) {
            if (state.step === 'await_video') {
                if (video) {
                    adminState.set(chatId, { step: 'await_code', fileId: video.file_id, caption: msg.caption || 'Kino' });
                    return bot.sendMessage(chatId, '✅ Video qabul. <b>Kod</b> yozing:', { parse_mode: 'HTML', ...cancelKeyboard });
                }
                return bot.sendMessage(chatId, '⚠️ Video fayl yuboring:');
            }

            if (state.step === 'await_code') {
                if (text) {
                    const code = text.trim();
                    const dup = await pgQuery('SELECT 1 FROM movies WHERE code = $1', [code]);
                    if (dup.rows[0]) {
                        return bot.sendMessage(chatId, '❌ Kod band. Boshqa kod:', cancelKeyboard);
                    }
                    bot.sendMessage(chatId, '⏳...');
                    try {
                        const sentMsg = await bot.sendVideo(dbChannelId, state.fileId, {
                            caption: `💿 ${code}\n📄 ${state.caption}\n👁 @${(await getBotUsername())}`
                        });
                        await pgQuery(
                            'INSERT INTO movies (code, file_id, caption, channel_msg_id) VALUES ($1,$2,$3,$4)',
                            [code, sentMsg.video.file_id, state.caption, sentMsg.message_id]
                        );
                        adminState.delete(chatId);
                        return bot.sendMessage(chatId, `✅ Qo'shildi. Kod: <code>${code}</code>`, { parse_mode: 'HTML', ...adminKeyboard });
                    } catch (err) {
                        console.error(err);
                        return bot.sendMessage(chatId, '❌ Bot maxfiy kanalda admin emas yoki ID xato.', cancelKeyboard);
                    }
                }
            }

            if (state.step === 'await_del_code') {
                if (text) {
                    const code = text.trim();
                    const m = await pgQuery('SELECT * FROM movies WHERE code = $1', [code]);
                    const movie = m.rows[0];
                    if (!movie) return bot.sendMessage(chatId, '❌ Topilmadi. Kod:', cancelKeyboard);
                    if (movie.channel_msg_id) {
                        try { await bot.deleteMessage(dbChannelId, movie.channel_msg_id); } catch (e) {}
                    }
                    await pgQuery('DELETE FROM movies WHERE id = $1', [movie.id]);
                    await pgQuery('DELETE FROM delivered_movies WHERE movie_code = $1', [code]);
                    adminState.delete(chatId);
                    return bot.sendMessage(chatId, `🗑 O'chirildi: <code>${code}</code>`, { parse_mode: 'HTML', ...adminKeyboard });
                }
            }

            if (state.step === 'add_ch_id') {
                try {
                    const chat = await bot.getChat(text);
                    let link = chat.username ? `https://t.me/${chat.username}` : null;
                    if (!link) {
                        try {
                            const inv = await bot.createChatInviteLink(text);
                            link = inv.invite_link;
                        } catch (e2) { console.log('Invite xato:', e2.message); }
                    }
                    if (!link) {
                        adminState.set(chatId, { step: 'add_ch_link', chId: text });
                        return bot.sendMessage(chatId, `Link yuboring (qo'lda):`, cancelKeyboard);
                    }
                    await pgQuery('INSERT INTO sponsor_channels (channel_id, link, name) VALUES ($1,$2,$3)', [text, link, chat.title]);
                    adminState.delete(chatId);
                    return bot.sendMessage(chatId, `✅ Qo'shildi: <b>${chat.title}</b>`, { parse_mode: 'HTML', ...adminKeyboard });
                } catch (err) {
                    return bot.sendMessage(chatId, '❌ ID topilmadi. Bot kanalda admin emas yoki ID xato.', cancelKeyboard);
                }
            }
            if (state.step === 'add_ch_link') {
                adminState.set(chatId, { ...state, step: 'add_ch_name' });
                return bot.sendMessage(chatId, 'Nom:', cancelKeyboard);
            }
            if (state.step === 'add_ch_name') {
                await pgQuery('INSERT INTO sponsor_channels (channel_id, link, name) VALUES ($1,$2,$3)', [state.chId, state.chLink, text]);
                adminState.delete(chatId);
                return bot.sendMessage(chatId, '✅ Qo\'shildi!', adminKeyboard);
            }

            if (state.step === 'broadcast') {
                const ur = await pgQuery('SELECT chat_id FROM users');
                const users = ur.rows;
                bot.sendMessage(chatId, `🚀 ${users.length} ga yuborilmoqda...`);
                let ok = 0, fail = 0;
                for (const u of users) {
                    if (u.chat_id < 0) continue;
                    try { await bot.copyMessage(u.chat_id, chatId, msg.message_id); ok++; }
                    catch (e) { fail++; }
                    await new Promise(r => setTimeout(r, 50));
                }
                adminState.delete(chatId);
                return bot.sendMessage(chatId, `✅ ${ok} | ❌ ${fail}`, adminKeyboard);
            }
            return;
        }

        switch (text) {
            case '/start':
            case '/panel':
                return bot.sendMessage(chatId, '👋 Admin panel!', adminKeyboard);
            case '🎬 Kino Yuklash':
                adminState.set(chatId, { step: 'await_video' });
                return bot.sendMessage(chatId, '📥 Video fayl yuboring:', cancelKeyboard);
            case "🗑 Kino O'chirish":
                adminState.set(chatId, { step: 'await_del_code' });
                return bot.sendMessage(chatId, '🗑 Kod yozing:', { parse_mode: 'HTML', ...cancelKeyboard });
            case '📢 Reklama Tarqatish':
                adminState.set(chatId, { step: 'broadcast' });
                return bot.sendMessage(chatId, '📢 Xabar yuboring:', cancelKeyboard);
            case '📊 Statistika':
                const uc = await pgQuery('SELECT COUNT(*)::int AS c FROM users');
                const mc = await pgQuery('SELECT COUNT(*)::int AS c FROM movies');
                return bot.sendMessage(chatId, `👥 ${uc.rows[0].c}\n💿 ${mc.rows[0].c}`, { parse_mode: 'HTML' });
            case '📢 Kanallar Sozlamasi':
    const r = await pgQuery('SELECT * FROM sponsor_channels');
    const channels = r.rows;
                let msgText = "Kanallar:\n\n";
                channels.forEach((ch, i) => msgText += `${i + 1}. <a href="${ch.link}">${ch.name}</a>\n`);
                return bot.sendMessage(chatId, msgText, {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "➕ Qo'shish", callback_data: 'add_ch' }],
                            [{ text: "➖ O'chirish", callback_data: 'del_ch' }]
                        ]
                    }
                });
        }
    }

    // --- USER ---
    if (text === '/start') {
        return bot.sendMessage(chatId, '👋 Kino kodini yuboring:');
    }

    if (text) {
        const mr = await pgQuery('SELECT * FROM movies WHERE code = $1', [text]);
        const movie = mr.rows[0];
        if (!movie) return bot.sendMessage(chatId, '❌ Bunday kod yo\'q');

        const missing = await getMissingChannels(chatId);
        if (missing.length > 0) {
            const old = pendingMovies.get(chatId);
            if (old && old.msgId) { try { await bot.deleteMessage(chatId, old.msgId); } catch (e) {} }
            const sent = await bot.sendMessage(chatId, 'A\'zo bo\'ling:', {
                reply_markup: buildSubKeyboard(missing)
            });
            pendingMovies.set(chatId, { code: movie.code, msgId: sent.message_id });
            return;
        }
        await sendMovie(chatId, movie.id);
    }
    })().catch(e => console.error('Message handler xato:', e && e.message));
});

// --- CALLBACK HANDLER ---
bot.on('callback_query', (query) => {
    (async () => {
    const chatId = query.message.chat.id;
    const data = query.data;

    // Admin har qanday tugma bossa — kutilayotgan matn holati bekor, tugma o'z vazifasini bajaradi
    if (chatId === adminId) adminState.delete(chatId);

    // ✅ Tekshirish — hammasini tekshiradi
    if (data === 'check_sub') {
        const missing = await getMissingChannels(chatId);
        if (missing.length === 0) {
            return finishSubscription(chatId, query.message.message_id, query.id);
        }
        const nums = missing.map((c, i) => i + 1).join(', ');
        bot.answerCallbackQuery(query.id, { text: `Qoldi: ${nums}`, show_alert: true });
        bot.editMessageReplyMarkup(buildSubKeyboard(missing), {
            chat_id: chatId,
            message_id: query.message.message_id
        });
        return;
    }

    // Admin: kanal qo'shish
    if (data === 'add_ch' && chatId === adminId) {
        adminState.set(chatId, { step: 'add_ch_id' });
        return bot.sendMessage(chatId, '📢 Kanal ID yozing:', cancelKeyboard);
    }

    // Admin: kanal o'chirish
    if (data === 'del_ch' && chatId === adminId) {
        const cr = await pgQuery('SELECT * FROM sponsor_channels');
        const channels = cr.rows;
        const kb = channels.map(ch => [{ text: `🗑 ${ch.name}`, callback_data: `delete_${ch.id}` }]);
        kb.push([{ text: '🔙 Bekor', callback_data: 'cancel_del' }]);
        return bot.editMessageText('Tanlang:', {
            chat_id: chatId,
            message_id: query.message.message_id,
            reply_markup: { inline_keyboard: kb }
        });
    }

    if (data.startsWith('delete_') && chatId === adminId) {
        await pgQuery('DELETE FROM sponsor_channels WHERE id = $1', [parseInt(data.split('_')[1], 10)]);
        return bot.sendMessage(chatId, '✅ O\'chirildi.');
    }

    if (data === 'cancel_del' && chatId === adminId) {
        return bot.deleteMessage(chatId, query.message.message_id);
    }
    })().catch(e => console.error('Callback xato:', e && e.message));
});

// ====================================================================
// TOPShIRIQ BOT — BIRGA ISHLAYDI ("Guruhda N ta a'zo qo'sh — yozishing o'chirilmaydi")
// ====================================================================
const tgToken = process.env.TOPSHIRIQ_TOKEN;

if (tgToken) {
    const topshiriqBot = new TelegramBot(tgToken, {
        polling: { params: { allowed_updates: ['message', 'callback_query', 'chat_member'] } }
    });
    topshiriqBot.on('polling_error', (e) => console.error('Topshiriq polling:', e && e.message));

    // --- YORDAMCHILAR ---
    const tgRetryAfter = (err) => {
        const s = (err && err.message) || '';
        const m = s.match(/retry after (\d+)/i);
        return m ? parseInt(m[1], 10) : 0;
    };
    const tgSleep = (ms) => new Promise(r => setTimeout(r, ms));

    const tgAdminCache = new Map();
    async function tgIsAdmin(chatId, userId) {
        const key = `${chatId}:${userId}`;
        const c = tgAdminCache.get(key);
        if (c && c.expires > Date.now()) return c.isAdmin;
        const check = async () => {
            const member = await topshiriqBot.getChatMember(chatId, userId);
            const ok = member.status === 'creator' || member.status === 'administrator';
            tgAdminCache.set(key, { isAdmin: ok, expires: Date.now() + 5 * 60 * 1000 });
            return ok;
        };
        try {
            return await check();
        } catch (err) {
            const rt = tgRetryAfter(err);
            if (rt) { await tgSleep(rt * 1000); try { return await check(); } catch (e2) { return false; } }
            return false;
        }
    }

    // --- 20s AVTO-O'CHIRISH XIZMATI ---
    const tgDeleteTimers = new Map();
    async function tgDoDelete(chatId, messageId) {
        try { await topshiriqBot.deleteMessage(chatId, messageId); } catch (e) {}
        try { await pgQuery('DELETE FROM tg_scheduled_deletions WHERE chat_id = $1 AND message_id = $2', [chatId, messageId]); } catch (e) {}
    }
    function tgScheduleDeletion(chatId, messageId, deleteAtMs) {
        const key = `${chatId}:${messageId}`;
        const delay = deleteAtMs - Date.now();
        if (delay <= 0) { tgDoDelete(chatId, messageId); return; }
        const timer = setTimeout(async () => {
            tgDeleteTimers.delete(key);
            await tgDoDelete(chatId, messageId);
        }, delay);
        tgDeleteTimers.set(key, timer);
    }
    async function tgRecoverDeletions() {
        if (!dbReady()) return;
        try {
            const now = new Date();
            const exp = await pgQuery('SELECT * FROM tg_scheduled_deletions WHERE delete_at <= $1', [now]);
            for (const en of exp.rows) tgDoDelete(en.chat_id, en.message_id);
            const pend = await pgQuery('SELECT * FROM tg_scheduled_deletions WHERE delete_at > $1', [now]);
            for (const en of pend.rows) tgScheduleDeletion(en.chat_id, en.message_id, new Date(en.delete_at).getTime());
            console.log('Topshiriq recovery:', exp.rows.length, 'muddati o\'tgan,', pend.rows.length, 'kutilayotgan');
        } catch (e) { console.error('Topshiriq recovery xato:', e && e.message); }
    }
    setInterval(async () => {
        if (!dbReady()) return;
        try {
            const exp = await pgQuery('SELECT * FROM tg_scheduled_deletions WHERE delete_at <= $1', [new Date()]);
            for (const en of exp.rows) tgDoDelete(en.chat_id, en.message_id);
        } catch (e) {}
    }, 5000);

    // --- IDEMPOTENTLIK ---
    const tgProcessed = new Set();
    setInterval(() => { if (tgProcessed.size > 10000) tgProcessed.clear(); }, 60000);

    // --- `/admin` PANELI ---
    const TG_OPTIONS = [1, 2, 3, 5, 10];
    const tgAdminSessions = new Map();
    function tgBuildKeyboard(requiredAdds) {
        const rows = [];
        rows.push([{ text: "➕ A'zo qo'shish", callback_data: 'admin_add_member' }]);
        let row = [];
        for (let i = 0; i < TG_OPTIONS.length; i++) {
            const n = TG_OPTIONS[i];
            row.push({ text: n === requiredAdds ? `✅ ${n}` : `${n}`, callback_data: `admin_set_${n}` });
            if (i % 2 === 1) { rows.push(row); row = []; }
        }
        if (row.length) rows.push(row);
        return { inline_keyboard: rows };
    }
    function tgPanelText(n) {
        return `🔧 <b>Admin Panel</b>\n\n📌 Hozirgi kerakli son: <b>${n}</b> ta a'zo\n\n👉 Pastdagi tugmalardan tanlang:`;
    }
    const TG_MEMBER_GUIDE = `📖 <b>A'zo qo'shish yo'riqnomasi</b>\n\n1️⃣ Guruhni oching\n2️⃣ Yuqoridagi <b>▾ sarlavha</b> yoki guruh nomi yonidagi belgini bosing\n3️⃣ <b>Add Members</b> yoki <b>➕</b> tugmasini tanlang\n4️⃣ Kontaktlaringizni belgilab <b>qo'shish</b> tugmasini bosing\n\nBajarilgach hisobingiz avtomatik yangilanadi. 🎉\n\n⚠️ <i>Siz qo'shgan a'zo guruhdan chiqib ketsa, sizning hisobingizdan ayriladi.</i>`;
    const TG_ADMIN_GUIDE = `📖 <b>A'zo qo'shish yo'riqnomasi</b>\n\n1️⃣ Guruhni oching\n2️⃣ Yuqoridan (sarlavha yonidagi) <b>➕</b> yoki <b>🗣 A'zolar</b> tugmasini bosing\n3️⃣ <b>Add Members</b> ni tanlang\n4️⃣ Kontaktlarni belgilab qo'shing\n\nBajarilgach, a'zolaringiz soni avtomatik hisoblanadi. 🎉`;

    async function tgUpsertGroup(chatId, title) {
        await pgQuery(
            'INSERT INTO tg_groups (telegram_group_id, title, is_active, required_adds) VALUES ($1,$2,TRUE,3) ON CONFLICT (telegram_group_id) DO UPDATE SET title = $2',
            [chatId, title || 'Unknown']
        );
        const r = await pgQuery('SELECT * FROM tg_groups WHERE telegram_group_id = $1', [chatId]);
        return r.rows[0];
    }
    async function tgEnsureUser(telegramUserId, groupId, requiredAdds) {
        await pgQuery(
            'INSERT INTO tg_users (telegram_user_id, group_id, current_adds, required_adds) VALUES ($1,$2,0,$3) ON CONFLICT (telegram_user_id, group_id) DO NOTHING',
            [telegramUserId, groupId, requiredAdds]
        );
    }
    async function tgSendReadyMessage(chatId, userId) {
        try {
            const member = await topshiriqBot.getChatMember(chatId, userId);
            const name = (member.user && member.user.first_name) || '';
            const sent = await topshiriqBot.sendMessage(
                chatId,
                `🎉 Xayrli kun, ${name}!\n\n✅ Siz kerakli a'zolarni qo'shdiz!\n✍️ Endi guruhda <b>bemalol yozishingiz</b> mumkin.\n\n👏 Tabriklaymiz, endi kun tartibi siz tomonda! 🚀`,
                { parse_mode: 'HTML' }
            );
            const deleteAt = Date.now() + 20000;
            try { await pgQuery('INSERT INTO tg_scheduled_deletions (chat_id, message_id, delete_at) VALUES ($1,$2,$3)', [chatId, sent.message_id, new Date(deleteAt)]); } catch (e) {}
            tgScheduleDeletion(chatId, sent.message_id, deleteAt);
        } catch (e) {
            const rt = tgRetryAfter(e);
            if (rt) { await tgSleep(rt * 1000); tgSendReadyMessage(chatId, userId); return; }
            console.error('Topshiriq tabrik xato:', e && e.message);
        }
    }

    // --- XABAR (guruh) ---
    const tgNotifMap = new Map();
    async function tgHandleMessage(msg) {
        try {
            if (!msg || !msg.chat) return;
            const ct = msg.chat.type;
            if (ct !== 'supergroup' && ct !== 'group') return;
            const userId = msg.from && msg.from.id;
            if (!userId) return;
            if (!dbReady()) return;

            const chatId = msg.chat.id;
            const group = await tgUpsertGroup(chatId, msg.chat.title);

            await tgEnsureUser(userId, chatId, group.required_adds);
            const ur = await pgQuery('SELECT * FROM tg_users WHERE telegram_user_id = $1 AND group_id = $2', [userId, chatId]);
            let user = ur.rows[0];

            if (await tgIsAdmin(chatId, userId)) {
                tgNotifMap.delete(`${chatId}:${userId}`);
                return;
            }

            if (user.current_adds >= user.required_adds) {
                tgNotifMap.delete(`${chatId}:${userId}`);
                return;
            }

            try { await topshiriqBot.deleteMessage(chatId, msg.message_id); } catch (e) {}

            const notifKey = `${chatId}:${userId}`;
            const remaining = user.required_adds - user.current_adds;
            const first = (msg.from && msg.from.first_name) || '';
            const text = user.current_adds === 0
                ? `👋 Salom, ${first}!\n\n😔 Afsuski, hozircha guruhda yozishimizga ruxsat yo'q.\n\n📋 <b>Shart:</b> Guruhda yozish uchun <b>${user.required_adds} ta a'zo</b> qo'shishingiz kerak.\n\n📊 Sizning holatingiz: <b>0 / ${user.required_adds}</b> 🙁\n\n✨ Pastdagi tugmani bosib, qanday qo'shish kerakligini ko'ring. Omad! 🍀`
                : `👋 Salom, ${first}!\n\n😔 Afsuski, hali ham guruhda yozishga ruxsat yo'q.\n\n📋 <b>Shart:</b> Guruhda yozish uchun <b>${user.required_adds} ta a'zo</b> qo'shishingiz kerak.\n\n📊 Sizning holatingiz: <b>${user.current_adds} / ${user.required_adds}</b> 👍\n\n➡️ Yana <b>${remaining} ta a'zo</b> qo'shsangiz, yozishingiz mumkin bo'ladi! 🎯\n\n✨ Pastdagi tugmani bosib, qanday qo'shish kerakligini ko'ring. Sizga omad! 🍀`;
            const keyboard = { inline_keyboard: [[{ text: "➕ A'zo qo'shish", callback_data: 'member_add_guide' }]] };

            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    const existingMsgId = tgNotifMap.get(notifKey);
                    if (existingMsgId) {
                        try {
                            await topshiriqBot.editMessageText(text, {
                                chat_id: chatId, message_id: existingMsgId, parse_mode: 'HTML', reply_markup: keyboard
                            });
                            tgScheduleDeletion(chatId, existingMsgId, Date.now() + 20000);
                            return;
                        } catch (e) { tgNotifMap.delete(notifKey); }
                    }
                    const sent = await topshiriqBot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
                    tgNotifMap.set(notifKey, sent.message_id);
                    const deleteAt = Date.now() + 20000;
                    try { await pgQuery('INSERT INTO tg_scheduled_deletions (chat_id, message_id, delete_at) VALUES ($1,$2,$3)', [chatId, sent.message_id, new Date(deleteAt)]); } catch (e) {}
                    tgScheduleDeletion(chatId, sent.message_id, deleteAt);
                    return;
                } catch (err) {
                    const rt = tgRetryAfter(err);
                    if (rt) { await tgSleep(rt * 1000); } else { return; }
                }
            }
        } catch (e) { console.error('Topshiriq msg xato:', e && e.message); }
    }

    async function tgHandleAdmin(msg) {
        try {
            if (!msg || !msg.chat) return;
            const ct = msg.chat.type;
            if (ct !== 'supergroup' && ct !== 'group') return;
            const userId = msg.from && msg.from.id;
            if (!userId) return;

            let member;
            try { member = await topshiriqBot.getChatMember(msg.chat.id, userId); } catch (e) { return; }
            if (member.status !== 'creator' && member.status !== 'administrator') {
                try { await topshiriqBot.sendMessage(msg.chat.id, '🚫 Faqat guruh adminlari bu buyruqdan foydalana oladi.'); } catch (e) {}
                return;
            }

            const group = await tgUpsertGroup(msg.chat.id, msg.chat.title);
            tgAdminSessions.set(userId, { chatId: msg.chat.id });
            try {
                await topshiriqBot.sendMessage(msg.chat.id, tgPanelText(group.required_adds), {
                    parse_mode: 'HTML', reply_markup: tgBuildKeyboard(group.required_adds)
                });
            } catch (e) {}
        } catch (e) { console.error('Topshiriq /admin xato:', e && e.message); }
    }

    topshiriqBot.on('message', (msg) => {
        (async () => {
            if (!msg || !msg.chat) return;
            if (msg.chat.type !== 'supergroup' && msg.chat.type !== 'group') return;
            if (msg.from && msg.from.is_bot) return;
            const text = msg.text;
            if (text && text.startsWith('/admin')) await tgHandleAdmin(msg);
            else await tgHandleMessage(msg);
        })().catch(e => console.error('Topshiriq message handler xato:', e && e.message));
    });

    // --- CHAT_MEMBER (a'zo qo'shildi / chiqdi) ---
    topshiriqBot.on('chat_member', (update) => {
        (async () => {
            try {
                const chat = update && update.chat;
                const newMember = update && update.new_chat_member;
                const newStatus = newMember && newMember.status;
                const oldStatus = update && update.old_chat_member && update.old_chat_member.status;
                const newMemberId = newMember && newMember.user && newMember.user.id;
                const fromId = update && update.from && update.from.id;
                if (!chat || !newMemberId) return;
                if (!dbReady()) return;

                const chatId = chat.id;
                const group = await tgUpsertGroup(chatId, chat.title);

                if (newStatus === 'member' && (oldStatus === 'left' || oldStatus === 'kicked')) {
                    await tgEnsureUser(newMemberId, chatId, group.required_adds);
                    if (fromId && fromId !== newMemberId) {
                        await tgEnsureUser(fromId, chatId, group.required_adds);
                        const ex = await pgQuery('SELECT 1 FROM tg_added_members WHERE added_user_id = $1 AND group_id = $2 AND adder_id = $3', [newMemberId, chatId, fromId]);
                        if (!ex.rows[0]) {
                            await pgQuery('INSERT INTO tg_added_members (adder_id, added_user_id, group_id, status) VALUES ($1,$2,$3,$4)', [fromId, newMemberId, chatId, 'ACTIVE']);
                            const upd = await pgQuery('UPDATE tg_users SET current_adds = current_adds + 1 WHERE telegram_user_id = $1 AND group_id = $2 RETURNING *', [fromId, chatId]);
                            const updatedAdder = upd.rows[0];
                            if (updatedAdder && updatedAdder.current_adds >= updatedAdder.required_adds) {
                                await tgSendReadyMessage(chatId, fromId);
                            }
                        }
                    }
                }

                if (newStatus === 'left' || newStatus === 'kicked') {
                    const added = await pgQuery('SELECT * FROM tg_added_members WHERE added_user_id = $1 AND group_id = $2 AND status = $3', [newMemberId, chatId, 'ACTIVE']);
                    for (const a of added.rows) {
                        await pgQuery('UPDATE tg_added_members SET status = $1 WHERE id = $2', ['LEFT', a.id]);
                        await pgQuery('UPDATE tg_users SET current_adds = current_adds - 1 WHERE telegram_user_id = $1 AND group_id = $2', [a.adder_id, chatId]);
                    }
                }
            } catch (e) { console.error('Topshiriq chat_member xato:', e && e.message); }
        })();
    });

    // --- CALLBACK (panel + yo'riqnoma) ---
    topshiriqBot.on('callback_query', (q) => {
        (async () => {
            try {
                const data = q && q.data;
                const chatId = q && q.message && q.message.chat.id;
                const userId = q && q.from && q.from.id;
                if (!chatId || !userId) return;

                if (data === 'member_add_guide') {
                    try { await topshiriqBot.answerCallbackQuery(q.id, { text: "👌 Yo'riqnoma" }); } catch (e) {}
                    const sent = await topshiriqBot.sendMessage(chatId, TG_MEMBER_GUIDE, { parse_mode: 'HTML' });
                    const deleteAt = Date.now() + 20000;
                    try { await pgQuery('INSERT INTO tg_scheduled_deletions (chat_id, message_id, delete_at) VALUES ($1,$2,$3)', [chatId, sent.message_id, new Date(deleteAt)]); } catch (e) {}
                    tgScheduleDeletion(chatId, sent.message_id, deleteAt);
                    return;
                }

                if (data && data.startsWith('admin_')) {
                    const session = tgAdminSessions.get(userId);
                    if (!session || session.chatId !== chatId) {
                        try { await topshiriqBot.answerCallbackQuery(q.id, { text: "🚫 Bu panel boshqa guruh uchun. Yangi /admin bosing." }); } catch (e) {}
                        return;
                    }
                    if (data === 'admin_add_member') {
                        try { await topshiriqBot.answerCallbackQuery(q.id, { text: "👌 Qo'llanma yuborildi" }); } catch (e) {}
                        const sent = await topshiriqBot.sendMessage(chatId, TG_ADMIN_GUIDE, { parse_mode: 'HTML' });
                        const deleteAt = Date.now() + 20000;
                        try { await pgQuery('INSERT INTO tg_scheduled_deletions (chat_id, message_id, delete_at) VALUES ($1,$2,$3)', [chatId, sent.message_id, new Date(deleteAt)]); } catch (e) {}
                        tgScheduleDeletion(chatId, sent.message_id, deleteAt);
                        tgAdminSessions.delete(userId);
                        return;
                    }
                    const m = data.match(/^admin_set_(\d+)$/);
                    if (m) {
                        const n = parseInt(m[1], 10);
                        if (TG_OPTIONS.includes(n)) {
                            await pgQuery('UPDATE tg_groups SET required_adds = $1 WHERE telegram_group_id = $2', [n, chatId]);
                            await pgQuery('UPDATE tg_users SET required_adds = $1 WHERE group_id = $2', [n, chatId]);
                            try {
                                await topshiriqBot.editMessageText(tgPanelText(n), {
                                    chat_id: chatId, message_id: q.message.message_id, parse_mode: 'HTML', reply_markup: tgBuildKeyboard(n)
                                });
                            } catch (e) {}
                            try { await topshiriqBot.answerCallbackQuery(q.id, { text: `✅ Kerakli son: ${n} ta qilindi.` }); } catch (e) {}
                            tgAdminSessions.delete(userId);
                        }
                    }
                }
            } catch (e) { console.error('Topshiriq callback xato:', e && e.message); }
        })();
    });

    // --- ISHGA TUSHIRISH ---
    (async () => {
        try {
            const me = await topshiriqBot.getMe();
            console.log('TOPSHIRIQ bot ishga tushdi: @' + me.username);
        } catch (e) { console.error('Topshiriq bot getMe xato:', e && e.message); }
        setTimeout(tgRecoverDeletions, 3000);
    })();
} else {
    console.log('TOPSHIRIQ_TOKEN yo\'q — topshiriq bot o\'chirilgan (kinobot ishlayapti).');
}