// src/env.d.ts
declare global {
    namespace NodeJS {
      interface ProcessEnv {
        ENDPOINT: string;
        SEED: string;
        OATH_TOKEN: string;
        CHANNEL_ID: string;
      }
    }
  }
  
  export {};