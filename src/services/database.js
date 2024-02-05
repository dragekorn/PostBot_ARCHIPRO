require('dotenv').config();
const { MongoClient } = require('mongodb');

let dbInstance = null;

async function connectToDB() {
    try {
        const client = new MongoClient(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
        console.log('MongoDB URI:', process.env.MONGODB_URI);
        await client.connect();
        dbInstance = client.db('autoPostBot');
        console.log('Successfully connected to MongoDB');
    } catch (error) {
        console.error('Error connecting to MongoDB:', error);
        throw error;
    }
}

function getDB() {
    if (!dbInstance) {
        throw new Error("Database not initialized"); 
    }

    return dbInstance;
}

module.exports = { connectToDB, getDB };
