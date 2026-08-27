require('dotenv').config();
const fs = require('fs');
const path = require('path');
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const express = require('express');

// --- SOZLAMALAR ---
const token = process.env.BOT_TOKEN;
const adminId = parseInt(process.env.ADMIN_ID);
const dbChannelId = process.env.DB_CHANNEL_ID;
const mongoUri = process.env.MONGO_URI;

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

// Baza ulanguncha operatsiyalar kutib qolib, process o'lmasligi uchun
mongoose.set('bufferCommands', false);

// Hech qanday xato botni o'ldirmasligi uchun himoya
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e && e.message || e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e && e.message || e));

// --- MODELLAR ---
const User = mongoose.model('User', new mongoose.Schema({
    chatId: { type: Number, unique: true },
    firstName: String,
    joinedAt: { type: Date, default: Date.now }
}));

const Movie = mongoose.model('Movie', new mongoose.Schema({
    code: { type: String, unique: true },
    fileId: String,
    caption: String,
    views: { type: Number, default: 0 },
    channelMsgId: Number
}));

const SponsorChannel = mongoose.model('SponsorChannel', new mongoose.Schema({
    channelId: String,
    name: String,
    link: String
}));

// --- MONGODB (uzilishda avto-qayta ulanish) ---
async function connectDB() {
    try {
        await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 15000 });
        console.log('MongoDB ulandi');
        updateBotBio();
        // Aloqa uzilsa — avtomatik qayta ulanish
        mongoose.connection.on('disconnected', () => {
            console.log('MongoDB uzildi, qayta ulanmoqda...');
            setTimeout(connectDB, 5000);
        });
    } catch (err) {
        console.error('MongoDB ulanishda xato:', err.message);
        setTimeout(connectDB, 10000);
    }
}
connectDB();
setInterval(updateBotBio, 3600 * 1000);

async function updateBotBio() {
    try {
        if (mongoose.connection.readyState !== 1) return;
        const userCount = await User.countDocuments();
        const movieCount = await Movie.countDocuments();
        await bot.setMyShortDescription({
            short_description: `🎬 Kino kodini yuboring!\n\n👥 ${userCount} | 💿 ${movieCount}`
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
    const channels = await SponsorChannel.find();
    const missing = [];
    for (const ch of channels) {
        let isSub = false;
        try {
            const m = await bot.getChatMember(ch.channelId, chatId);
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
    try { await Movie.deleteOne({ _id: movieId }); } catch (e) { console.error(e); }
}

async function sendMovie(chatId, movieId) {
    try {
        const upd = await Movie.findOneAndUpdate({ _id: movieId }, { $inc: { views: 1 } }, { returnDocument: 'after' });
        if (!upd) return false;
        await bot.sendVideo(chatId, upd.fileId, {
            caption: `🎬 <b>${upd.caption}</b>\n\n👁 Ko'rishlar: ${upd.views}\n🤖 Bot: @${await getBotUsername()}`,
            parse_mode: 'HTML'
        });
        return true;
    } catch (e) {
        // Fayl kanalda hali bormi — yo'q bo'lsa bazadan avto o'chiramiz
        let alive = false;
        if (upd) {
            try { await bot.getFile(upd.fileId); alive = true; } catch (e2) {}
        }
        if (upd && !alive) {
            await cleanupMovie(upd._id);
            bot.sendMessage(chatId, '❌ Bu kod bekor qilingan');
        } else {
            bot.sendMessage(chatId, '❌ Kino uzilmadi');
        }
        return false;
    }
}

// --- KANALDA YO'QOLGAN KINOLARNI AVTO-SKANER QILISH (kanaldan o'chirilganlar bazadan ham o'chiriladi) ---
let scanningStale = false;
async function scanStaleMovies() {
    if (scanningStale) return;
    if (mongoose.connection.readyState !== 1) return;
    scanningStale = true;
    try {
        const movies = await Movie.find();
        for (const mv of movies) {
            try {
                await bot.getFile(mv.fileId);
            } catch (e) {
                console.log('Kanalda yo\'q, bazadan o\'chirilmoqda:', mv.code);
                await cleanupMovie(mv._id);
            }
            await new Promise(r => setTimeout(r, 250));
        }
    } finally {
        scanningStale = false;
    }
}
setInterval(scanStaleMovies, 10 * 60 * 1000);

async function finishSubscription(chatId, msgId, queryId) {
    try { if (queryId) await bot.answerCallbackQuery(queryId, { text: '✅' }); } catch (e) {}
    try { await bot.deleteMessage(chatId, msgId); } catch (e) {}
    const pend = pendingMovies.get(chatId);
    if (pend) {
        pendingMovies.delete(chatId);
        const movie = await Movie.findOne({ code: pend.code });
        if (movie) await sendMovie(chatId, movie._id);
    } else {
        bot.sendMessage(chatId, '✅');
    }
}

// --- OBUNA AVTO-YANGILANISHI (hech narsa bosmasdan tugmalar o'zi o'chadi) ---
let refreshing = false;
async function refreshPendingSubs() {
    if (refreshing) return;
    if (pendingMovies.size === 0) return;
    if (mongoose.connection.readyState !== 1) return;
    refreshing = true;
    try {
        for (const [chatId, pend] of pendingMovies) {
            const missing = await getMissingChannels(chatId);
            if (missing.length === 0) {
                // Hammasiga a'zo bo'ldi — kino avto yuboriladi, tugmalar o'chadi
                if (pendingMovies.get(chatId) === pend) pendingMovies.delete(chatId);
                try { await bot.deleteMessage(chatId, pend.msgId); } catch (e) {}
                const movie = await Movie.findOne({ code: pend.code });
                if (movie) await sendMovie(chatId, movie._id);
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
    if (mongoose.connection.readyState === 1) {
        try {
            if (!await User.exists({ chatId })) {
                await new User({ chatId, firstName: msg.chat.first_name }).save();
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

        if (state) {
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
                    if (await Movie.findOne({ code })) {
                        return bot.sendMessage(chatId, '❌ Kod band. Boshqa kod:', cancelKeyboard);
                    }
                    bot.sendMessage(chatId, '⏳...');
                    try {
                        const sentMsg = await bot.sendVideo(dbChannelId, state.fileId, {
                            caption: `💿 ${code}\n📄 ${state.caption}\n👁 @${(await getBotUsername())}`
                        });
                        await new Movie({
                            code,
                            fileId: sentMsg.video.file_id,
                            caption: state.caption,
                            channelMsgId: sentMsg.message_id
                        }).save();
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
                    const movie = await Movie.findOne({ code });
                    if (!movie) return bot.sendMessage(chatId, '❌ Topilmadi. Kod:', cancelKeyboard);
                    if (movie.channelMsgId) {
                        try { await bot.deleteMessage(dbChannelId, movie.channelMsgId); } catch (e) {}
                    }
                    await Movie.deleteOne({ _id: movie._id });
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
                    await new SponsorChannel({ channelId: text, link, name: chat.title }).save();
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
                await new SponsorChannel({ channelId: state.chId, link: state.chLink, name: text }).save();
                adminState.delete(chatId);
                return bot.sendMessage(chatId, '✅ Qo\'shildi!', adminKeyboard);
            }

            if (state.step === 'broadcast') {
                const users = await User.find();
                bot.sendMessage(chatId, `🚀 ${users.length} ga yuborilmoqda...`);
                let ok = 0, fail = 0;
                for (const u of users) {
                    if (u.chatId < 0) continue;
                    try { await bot.copyMessage(u.chatId, chatId, msg.message_id); ok++; }
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
                const uCount = await User.countDocuments();
                const mCount = await Movie.countDocuments();
                return bot.sendMessage(chatId, `👥 ${uCount}\n💿 ${mCount}`, { parse_mode: 'HTML' });
            case '📢 Kanallar Sozlamasi':
                const channels = await SponsorChannel.find();
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
        const movie = await Movie.findOne({ code: text });
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
        await sendMovie(chatId, movie._id);
    }
    })().catch(e => console.error('Message handler xato:', e && e.message));
});

// --- CALLBACK HANDLER ---
bot.on('callback_query', (query) => {
    (async () => {
    const chatId = query.message.chat.id;
    const data = query.data;

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
        const channels = await SponsorChannel.find();
        const kb = channels.map(ch => [{ text: `🗑 ${ch.name}`, callback_data: `delete_${ch._id}` }]);
        kb.push([{ text: '🔙 Bekor', callback_data: 'cancel_del' }]);
        return bot.editMessageText('Tanlang:', {
            chat_id: chatId,
            message_id: query.message.message_id,
            reply_markup: { inline_keyboard: kb }
        });
    }

    if (data.startsWith('delete_') && chatId === adminId) {
        await SponsorChannel.findByIdAndDelete(data.split('_')[1]);
        return bot.sendMessage(chatId, '✅ O\'chirildi.');
    }

    if (data === 'cancel_del' && chatId === adminId) {
        return bot.deleteMessage(chatId, query.message.message_id);
    }
    })().catch(e => console.error('Callback xato:', e && e.message));
});