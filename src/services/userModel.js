const { getDB } = require('./database');

async function addUser(userId) {
    try {
        const db = getDB();
        if (!db) {
            throw new Error("Database not initialized");
        }
        await db.collection('users').updateOne({ userId }, { $set: { userId } }, { upsert: true });
    } catch (error) {
        console.error('Error in addUser:', error);
        throw error;
    }
}

async function getAllUsers() {
    const db = getDB();
    return await db.collection('users').find({}).toArray();
}

module.exports = { addUser, getAllUsers };
