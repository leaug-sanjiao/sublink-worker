import { generateWebPath } from '../utils.js';
import { MissingDependencyError, ServiceError } from './errors.js';

export class ShortLinkService {
    constructor(kv, options = {}) {
        this.kv = kv;
        this.options = options;
    }

    ensureKv() {
        if (!this.kv) {
            throw new MissingDependencyError('Short link service requires a KV store');
        }
        return this.kv;
    }

    async createShortLink(queryString, providedCode) {
        const kv = this.ensureKv();
        const shortCode = providedCode || generateWebPath();
        const existing = await kv.get(shortCode);
        if (existing !== null && existing !== undefined
            && new URLSearchParams(existing).get('config') !== new URLSearchParams(queryString).get('config')) {
            throw new ServiceError('This short code belongs to another subscription. Use a different short code.', 409);
        }
        const ttl = this.options.shortLinkTtlSeconds;
        const putOptions = ttl ? { expirationTtl: ttl } : undefined;
        await kv.put(shortCode, queryString, putOptions);
        return shortCode;
    }

    async resolveShortCode(code) {
        const kv = this.ensureKv();
        return kv.get(code);
    }
}
