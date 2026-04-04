import fetch from 'node-fetch';

export class ImageProvider {
    static async getRandomUrl(tag) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        try {
            const query = encodeURIComponent(`${tag} (rating:s OR rating:q) order:random`);
            const url = `https://yande.re/post.json?tags=${query}&limit=1`;
            
            const response = await fetch(url, {
                signal: controller.signal,
                headers: { 'User-Agent': 'kamijs-gacha/1.0' }
            });
            
            if (!response.ok) {
                throw new Error(`HTTP Error: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (!Array.isArray(data) || !data.length) return null;
            return data[0].sample_url || data[0].file_url;
            
        } catch (e) {
            console.warn(`[kamijs - ImageProvider] Fallo para ${tag}:`, e.message);
            return null;
        } finally {
            clearTimeout(timeout);
        }
    }
}
