require('dotenv').config();
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

const mongoUri = process.env.MONGO_URI;
const backupDir = path.join(__dirname, 'backup');

async function main() {
    const files = fs.readdirSync(backupDir).filter(f => f.endsWith('.json')).sort();
    if (files.length === 0) {
        console.log('Backup fayllar topilmadi. Avval `node backup.js` ishga tushiring.');
        process.exit(1);
    }

    const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 15000 });
    try {
        await client.connect();
        const db = client.db();

        for (const file of files) {
            const collectionName = file.split('_').slice(2).join('_').replace('.json', '');
            const data = JSON.parse(fs.readFileSync(path.join(backupDir, file), 'utf8'));

            if (data.length === 0) continue;

            const col = db.collection(collectionName);
            await col.deleteMany({});
            if (data.length > 0) {
                await col.insertMany(data);
            }
            console.log(`OK ${collectionName}: ${data.length} ta yozuv tiklandi`);
        }
        console.log('Restore tugadi!');
    } finally {
        await client.close();
    }
}

main().catch(e => {
    console.error('Xato:', e.message);
    process.exit(1);
});