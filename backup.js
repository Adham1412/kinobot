require('dotenv').config();
const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']);
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

const mongoUri = process.env.MONGO_URI;
const backupDir = path.join(__dirname, 'backup');

async function main() {
    fs.mkdirSync(backupDir, { recursive: true });

    const client = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 15000 });
    try {
        await client.connect();
        const db = client.db();
        const collections = await db.listCollections().toArray();
        const timestamp = new Date().toISOString().slice(0, 10) + '_' + new Date().toISOString().slice(11, 19).replace(/:/g, '-');

        if (collections.length === 0) {
            console.log('Bazada collection topilmadi.');
            return;
        }

        for (const col of collections) {
            const data = await db.collection(col.name).find({}).toArray();
            const file = path.join(backupDir, `${timestamp}_${col.name}.json`);
            fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
            console.log(`OK ${col.name}: ${data.length} ta yozuv -> ${file}`);
        }
        console.log('Backup tugadi!');

        const files = fs.readdirSync(backupDir).filter(f => f.endsWith('.json')).sort();
        while (files.length > 5) {
            const old = files.shift();
            fs.unlinkSync(path.join(backupDir, old));
            console.log(`Eski backup ochirildi: ${old}`);
        }
    } finally {
        await client.close();
    }
}

main().catch(e => {
    console.error('Xato:', e.message);
    process.exit(1);
});