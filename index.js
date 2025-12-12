require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const express = require('express');
   
// --- SOZLAMALAR ---
const token = process.env.BOT_TOKEN;
const adminId = parseInt(process.env.ADMIN_ID);
const dbChannelId = process.env.DB_CHANNEL_ID; // Maxfiy kanal IDsi (-100 bilan boshlanadi)
const mongoUri = process.env.MONGO_URI;

// --- SERVER (Render.com uchun majburiy) ---
const app = express();
app.get('/', (req, res) => res.send('Bot faol va ishlamoqda!'));
app.listen(process.env.PORT || 3000, () => console.log('Server ishladi'));

// --- BOTNI ULAB OLISH ---
const bot = new TelegramBot(token, { polling: true });

// --- BIO AVTO-YANGILASH (Siz so'ragan funksiya) ---
async function updateBotBio() {
    try {
        const userCount = await User.countDocuments();
        const movieCount = await Movie.countDocuments();
        
        // Botning "About" qismiga yoziladi (Profilga kirganda ko'rinadi)
        // Eslatma: Telegram API cheklovi bor, juda tez o'zgartirib bo'lmaydi.
        const bioText = `🎬 Eng so'nggi premyeralar bizda!\n\n👥 Foydalanuvchilar: ${userCount} ta\n💿 Kinolar: ${movieCount} ta\n\n✅ Rasmiy bot`;
        
        await bot.setMyShortDescription({ short_description: bioText });
        console.log('✅ Bot Bio yangilandi:', userCount);
    } catch (error) {
        console.error('Bio yangilashda xato:', error.message);
    }
}
// Har 1 soatda bioni yangilash (spam bo'lmasligi uchun)
setInterval(updateBotBio, 3600 * 1000);

// --- MONGODB BAZA ---
mongoose.connect(mongoUri)
    .then(() => console.log('✅ MongoDB ulandi'))
    .catch(err => console.error('❌ MongoDB xatosi:', err));

// 1. Foydalanuvchi sxemasi
const User = mongoose.model('User', new mongoose.Schema({
    chatId: { type: Number, unique: true },
    firstName: String,
    joinedAt: { type: Date, default: Date.now }
}));

// 2. Kino sxemasi
const Movie = mongoose.model('Movie', new mongoose.Schema({
    code: { type: String, unique: true },
    fileId: String, 
    caption: String,
    views: { type: Number, default: 0 }
}));

// 3. Majburiy Obuna Kanallari
const SponsorChannel = mongoose.model('SponsorChannel', new mongoose.Schema({
    channelId: String,
    name: String,
    link: String
}));

// --- ADMIN HOLATINI BOSHQARISH (STATE) ---
// Admin hozir nima qilayotganini saqlash uchun
const adminState = new Map(); 

// Admin klaviaturasi
const adminKeyboard = {
    reply_markup: {
        keyboard: [
            ['🎬 Kino Yuklash', '📊 Statistika'],
            ['📢 Reklama Tarqatish', '📢 Kanallar Sozlamasi']
        ],
        resize_keyboard: true,
        one_time_keyboard: false
    }
};

const cancelKeyboard = {
    reply_markup: {
        keyboard: [['🚫 Bekor qilish']],
        resize_keyboard: true
    }
};

// --- YORDAMCHI FUNKSIYALAR ---

// Obunani tekshirish
async function checkSubscription(chatId) {
    if (chatId === adminId) return true;
    const channels = await SponsorChannel.find();
    if (channels.length === 0) return true;

    for (const channel of channels) {
        try {
            const chatMember = await bot.getChatMember(channel.channelId, chatId);
            // Agar user: left, kicked (ban) bo'lsa false qaytaradi
            if (['left', 'kicked'].includes(chatMember.status)) {
                return false;
            }
        } catch (error) {
            console.log(`Kanal tekshirishda xato (${channel.name}):`, error.message);
            // Bot kanalda admin bo'lmasa, userga ruxsat berib yuboramiz (xatolik bo'lmasligi uchun)
            continue;
        }
    }
    return true;
}

// Obuna tugmalarini yaratish
async function getSubscriptionKeyboard() {
    const channels = await SponsorChannel.find();
    const keyboard = channels.map(ch => [{ text: `➕ ${ch.name}`, url: ch.link }]);
    keyboard.push([{ text: "✅ Tasdiqlash", callback_data: "check_sub" }]);
    return { inline_keyboard: keyboard };
}

// --- ASOSIY MESSAGE HANDLER ---
// Hamma xabarlar shu yerga keladi va tartib bilan qayta ishlanadi
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const video = msg.video;

    // 1. Bazaga yangi foydalanuvchini qo'shish
    try {
        if (!await User.exists({ chatId })) {
            await new User({ chatId, firstName: msg.chat.first_name }).save();
        }
    } catch (e) { console.error(e); }

    // 2. AGAR ADMIN BO'LSA
    if (chatId === adminId) {
        // A) Bekor qilish komandasi
        if (text === '🚫 Bekor qilish' || text === '/cancel') {
            adminState.delete(chatId);
            return bot.sendMessage(chatId, "❌ Jarayon bekor qilindi.", adminKeyboard);
        }

        // B) Hozirgi holatni (State) tekshiramiz
        const state = adminState.get(chatId);

        if (state) {
            // --- KINO YUKLASH JARAYONI ---
            
            // 1-qadam: Video kutyapmiz
            if (state.step === 'await_video') {
                if (video) {
                    // Videoni vaqtinchalik xotiraga olamiz
                    adminState.set(chatId, { step: 'await_code', fileId: video.file_id, caption: msg.caption || "Kino" });
                    return bot.sendMessage(chatId, "✅ Video qabul qilindi.\n\nEndi ushbu kinoga <b>kod</b> yozing (faqat raqam yoki so'z):", { parse_mode: 'HTML', ...cancelKeyboard });
                } else {
                    return bot.sendMessage(chatId, "⚠️ Iltimos, video fayl yuboring yoki 'Bekor qilish' ni bosing.");
                }
            }

            // 2-qadam: Kod kutyapmiz
            if (state.step === 'await_code') {
                if (text) {
                    const code = text.trim();
                    const existing = await Movie.findOne({ code });
                    if (existing) return bot.sendMessage(chatId, "❌ Bu kod band! Boshqa kod yozing:");

                    bot.sendMessage(chatId, "⏳ Kino maxfiy kanalga yuklanmoqda...");

                    try {
                        // 1. Videoni Maxfiy Kanalga forward qilamiz (yoki copy)
                        // Biz sendVideo ishlatamiz, shunda yangi post bo'lib tushadi
                        const sentMsg = await bot.sendVideo(dbChannelId, state.fileId, {
                            caption: `💿 Kod: ${code}\n📄 Nom: ${state.caption}\n👁 Bot: @${(await bot.getMe()).username}`
                        });

                        // 2. Kanalga tushgan yangi file_id ni olamiz
                        const finalFileId = sentMsg.video.file_id;

                        // 3. Bazaga saqlaymiz
                        await new Movie({
                            code: code,
                            fileId: finalFileId,
                            caption: state.caption
                        }).save();

                        adminState.delete(chatId); // Holatni tozalaymiz
                        return bot.sendMessage(chatId, `✅ <b>Muvaffaqiyatli!</b>\n\nKino bazaga qo'shildi.\nKod: <code>${code}</code>`, { parse_mode: 'HTML', ...adminKeyboard });

                    } catch (err) {
                        console.error(err);
                        return bot.sendMessage(chatId, `❌ Xatolik: Bot maxfiy kanalda (${dbChannelId}) Admin emas yoki ID xato kiritilgan.`);
                    }
                }
            }

            // --- KANAL QO'SHISH JARAYONI ---
            if (state.step === 'add_ch_id') {
                adminState.set(chatId, { step: 'add_ch_link', chId: text });
                return bot.sendMessage(chatId, "Kanal ssilkasini yuboring (https://t.me/...):");
            }
            if (state.step === 'add_ch_link') {
                const currentData = adminState.get(chatId);
                adminState.set(chatId, { ...currentData, step: 'add_ch_name', chLink: text });
                return bot.sendMessage(chatId, "Kanal nomini yozing (Tugmada ko'rinadigan nom):");
            }
            if (state.step === 'add_ch_name') {
                const { chId, chLink } = adminState.get(chatId);
                await new SponsorChannel({ channelId: chId, link: chLink, name: text }).save();
                adminState.delete(chatId);
                return bot.sendMessage(chatId, "✅ Kanal muvaffaqiyatli qo'shildi!", adminKeyboard);
            }

            // --- REKLAMA TARQATISH JARAYONI ---
            if (state.step === 'broadcast') {
                const users = await User.find();
                bot.sendMessage(chatId, `🚀 Xabar ${users.length} kishiga yuborilmoqda... Jarayon biroz vaqt olishi mumkin.`);
                
                let success = 0;
                // Asinxron tarqatish (Serverni qotirmaslik uchun)
                users.forEach((u, i) => {
                    setTimeout(() => {
                        bot.copyMessage(u.chatId, chatId, msg.message_id)
                            .then(() => success++)
                            .catch((e) => {}); 
                    }, i * 50); // Har 50ms da bitta xabar
                });

                adminState.delete(chatId);
                return bot.sendMessage(chatId, "✅ Reklama tarqatish boshlandi.", adminKeyboard);
            }

            return; // Agar state bo'lsa, pastdagi komandalarni o'qimasin
        }

        // C) Admin Asosiy Buyruqlari (State yo'q bo'lganda)
        switch (text) {
            case '/start':
            case '/panel':
                return bot.sendMessage(chatId, "👋 Admin panelga xush kelibsiz!", adminKeyboard);
            
            case '🎬 Kino Yuklash':
                adminState.set(chatId, { step: 'await_video' });
                return bot.sendMessage(chatId, "📥 Kinoni (video fayl) yuboring:", cancelKeyboard);
            
            case '📢 Reklama Tarqatish':
                adminState.set(chatId, { step: 'broadcast' });
                return bot.sendMessage(chatId, "📢 Tarqatiladigan xabarni yuboring (Matn, Rasm, Video...):", cancelKeyboard);
            
            case '📊 Statistika':
                const uCount = await User.countDocuments();
                const mCount = await Movie.countDocuments();
                return bot.sendMessage(chatId, `📊 <b>Statistika:</b>\n\n👥 Foydalanuvchilar: ${uCount}\n🎬 Kinolar: ${mCount}`, { parse_mode: 'HTML' });
            
            case '📢 Kanallar Sozlamasi':
                const channels = await SponsorChannel.find();
                let msgText = "<b>Ulangan Kanallar:</b>\n\n";
                channels.forEach((ch, i) => msgText += `${i+1}. <a href="${ch.link}">${ch.name}</a> (ID: <code>${ch.channelId}</code>)\n`);
                return bot.sendMessage(chatId, msgText, {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "➕ Qo'shish", callback_data: "add_ch" }],
                            [{ text: "➖ O'chirish", callback_data: "del_ch" }]
                        ]
                    }
                });
        }
    }

    // 3. ODDIY FOYDALANUVCHI LOGIKASI
    
    // Obunani tekshirish
    if (!await checkSubscription(chatId)) {
        const subKeyboard = await getSubscriptionKeyboard();
        return bot.sendMessage(chatId, "⚠️ Botdan to'liq foydalanish uchun quyidagi kanallarga obuna bo'ling va <b>'Tasdiqlash'</b> tugmasini bosing:", {
            reply_markup: subKeyboard
        });
    }

    // /start komandasi
    if (text === '/start') {
        return bot.sendMessage(chatId, `👋 Assalomu alaykum, <b>${msg.chat.first_name}</b>!\n\n🎬 Kino kodini yuboring:`, { parse_mode: 'HTML' });
    }

    // Kino kodini tekshirish
    if (text) {
        const movie = await Movie.findOne({ code: text });
        if (movie) {
            // Kinoni yuborish (CopyMessage eng tezi, lekin Caption o'zgartirib bo'lmaydi, shuning uchun sendVideo)
            try {
                await bot.sendVideo(chatId, movie.fileId, {
                    caption: `🎬 <b>${movie.caption}</b>\n\n👁 Ko'rishlar: ${movie.views + 1}\n🤖 Bot: @${(await bot.getMe()).username}`,
                    parse_mode: 'HTML'
                });
                // Ko'rishlar sonini oshirish
                await Movie.updateOne({ _id: movie._id }, { $inc: { views: 1 } });
            } catch (err) {
                bot.sendMessage(chatId, "❌ Kino yuklashda xatolik. Kino o'chib ketgan bo'lishi mumkin.");
            }
        } else {
            bot.sendMessage(chatId, "❌ Bunday kod mavjud emas. Kodni to'g'ri yozing.");
        }
    }
});

// --- CALLBACK QUERY HANDLER (TUGMALAR UCHUN) ---
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    // Obuna tasdiqlash
    if (data === 'check_sub') {
        if (await checkSubscription(chatId)) {
            bot.deleteMessage(chatId, query.message.message_id);
            bot.sendMessage(chatId, "✅ Obuna tasdiqlandi! Marhamat, kino kodini yuboring.");
        } else {
            bot.answerCallbackQuery(query.id, { text: "❌ Hali kanallarga a'zo bo'lmadingiz!", show_alert: true });
        }
    }

    // Admin: Kanal qo'shish
    if (data === 'add_ch' && chatId === adminId) {
        adminState.set(chatId, { step: 'add_ch_id' });
        bot.sendMessage(chatId, "📢 Yangi kanalning ID raqamini yuboring (Bot shu kanalda admin bo'lishi shart!)\nMasalan: -1001234567890", cancelKeyboard);
    }

    // Admin: Kanal o'chirish
    if (data === 'del_ch' && chatId === adminId) {
        const channels = await SponsorChannel.find();
        const kb = channels.map(ch => [{ text: `🗑 ${ch.name}`, callback_data: `delete_${ch._id}` }]);
        kb.push([{ text: "🔙 Bekor qilish", callback_data: "cancel_del" }]);
        
        bot.editMessageText("O'chirmoqchi bo'lgan kanalni tanlang:", {
            chat_id: chatId,
            message_id: query.message.message_id,
            reply_markup: { inline_keyboard: kb }
        });
    }

    // Admin: O'chirishni tasdiqlash
    if (data.startsWith('delete_') && chatId === adminId) {
        const id = data.split('_')[1];
        await SponsorChannel.findByIdAndDelete(id);
        bot.sendMessage(chatId, "✅ Kanal o'chirildi.");
    }
    
    if (data === 'cancel_del' && chatId === adminId) {
        bot.deleteMessage(chatId, query.message.message_id);
    }

});

