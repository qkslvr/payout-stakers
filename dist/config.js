// config.ts
import dotenv from 'dotenv';
dotenv.config();
export const config = {
    endpoint: process.env.ENDPOINT,
    seed: process.env.SEED,
    oathToken: process.env.OATH_TOKEN,
    channelId: process.env.CHANNEL_ID
};
