import { Kamijs } from '../src/index.js';
import fs from 'fs-extra';
import path from 'path';

const kamijs = new Kamijs({
    dbPath: './database/gacha.db',
    jsonPath: './database/characters.json'
});

async function runSeeder() {
    const sourcePath = path.resolve('./data/initial_characters.json');
    
    if (!fs.existsSync(sourcePath)) {
        console.error("❌ Error: Archivo fuente no encontrado.");
        process.exit(1);
    }

    try {
        const { characters } = await fs.readJson(sourcePath);
        await kamijs.init();

        console.log(`🚀 Procesando ${characters.length} personajes...`);

        const totalAdded = await kamijs.bulkAddCharacters(characters);

        console.log(`\n✨ ¡Éxito!`);
        console.log(`✅ Personajes nuevos en DB y JSON: ${totalAdded}`);
        console.log(`ℹ️ Personajes totales procesados: ${characters.length}`);
        process.exit(0);
    } catch (error) {
        console.error("❌ Error crítico:", error.message);
        process.exit(1);
    }
}

runSeeder();
