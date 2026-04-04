import fetch from 'node-fetch';

export class ImageProvider {
    static async getRandomUrl(tag) {
        try {
            const query = encodeURIComponent(`${tag} (rating:s OR rating:q) order:random`);
            const url = `https://yande.re/post.json?tags=${query}&limit=1`;
            
            const response = await fetch(url);
            const data = await response.json();
            
            if (!Array.isArray(data) || !data.length) return null;
            return data[0].sample_url || data[0].file_url;
        } catch (e) {
            console.warn('[kamijs - ImageProvider]:', e.message);
            return null;
        }
    }
}
