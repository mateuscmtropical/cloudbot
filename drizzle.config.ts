import { defineConfig } from 'drizzle-kit';

export default defineConfig({
    dialect: 'sqlite',
    schema: './src/server/store/schema.ts',
    out: './drizzle',
});
