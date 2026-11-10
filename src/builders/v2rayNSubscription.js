import { encodeBase64 } from '../utils.js';
import { InvalidConfigError } from '../services/errors.js';

const TYPES = {
    vmess: { value: 1, scheme: 'vmess' },
    shadowsocks: { value: 3, scheme: 'shadowsocks' },
    socks: { value: 4, scheme: 'socks' },
    vless: { value: 5, scheme: 'vless' },
    trojan: { value: 6, scheme: 'trojan' }
};

function shareLink(scheme, profile) {
    const payload = encodeBase64(JSON.stringify(profile)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `v2rayn://${scheme}/${payload}`;
}

function convertNode(node, index) {
    const type = TYPES[node.type];
    if (!type || node.plugin || (node.type === 'socks' && node.version && String(node.version) !== '5')) {
        throw new InvalidConfigError('This v2rayN/v2rayNG output supports standalone VMess, VLESS, Shadowsocks, SOCKS5 and Trojan nodes without plugins');
    }
    const transport = node.transport || {};
    const network = transport.type || (['vmess', 'vless', 'trojan'].includes(node.type) && node.network) || 'tcp';
    if (!['tcp', 'ws', 'grpc', 'httpupgrade'].includes(network)) {
        throw new InvalidConfigError('This v2rayN/v2rayNG output supports TCP, WebSocket, gRPC and HTTPUpgrade transports');
    }
    const tls = node.tls || {};
    const alpn = tls.alpn || node.alpn;
    const profile = {
        IndexId: 'node-' + index,
        ConfigType: type.value,
        ConfigVersion: 4,
        CoreType: 2,
        Remarks: node.tag,
        Address: node.server,
        Port: Number(node.server_port),
        Password: node.uuid || node.password || '',
        Username: node.username || '',
        Network: network === 'tcp' ? 'raw' : network,
        StreamSecurity: tls.reality?.enabled ? 'reality' : tls.enabled ? 'tls' : '',
        AllowInsecure: String(!!tls.insecure),
        Sni: tls.server_name || '',
        Alpn: Array.isArray(alpn) ? alpn.join(',') : alpn || '',
        Fingerprint: tls.utls?.fingerprint || '',
        PublicKey: tls.reality?.public_key || '',
        ShortId: tls.reality?.short_id || '',
        ProtoExtraObj: {
            AlterId: Number(node.alter_id || 0),
            VmessSecurity: node.security || 'auto',
            Flow: node.flow || '',
            VlessEncryption: 'none',
            SsMethod: node.method || ''
        },
        TransportExtraObj: {
            Host: transport.headers?.Host || transport.headers?.host || transport.host || '',
            Path: transport.path || '',
            GrpcServiceName: transport.service_name || '',
            GrpcAuthority: transport.authority || ''
        }
    };
    return { profile, scheme: type.scheme };
}

export function generateV2rayNSubscription(combination) {
    const frontNames = new Set(combination.fronts.map(node => node.tag));
    const excludedFronts = new Set();
    const nodes = combination.nodes.filter(node => {
        if (node.detour) return false;
        if (!frontNames.has(node.tag)) return true;
        try {
            convertNode(node, 0);
            return true;
        } catch (error) {
            if (!(error instanceof InvalidConfigError)) throw error;
            excludedFronts.add(node.tag);
            return false;
        }
    });
    const byName = new Map();
    const usedNames = new Set();
    const converted = nodes.map((node, index) => {
        const item = convertNode(node, index);
        // v2rayNG stores chain references as comma-separated node remarks.
        const baseName = node.tag.replace(/,/g, '，');
        let name = baseName;
        let suffix = 2;
        while (usedNames.has(name)) name = baseName + ' ' + suffix++;
        usedNames.add(name);
        item.profile.Remarks = name;
        byName.set(node.tag, item.profile);
        return item;
    });
    const links = converted.map(item => shareLink(item.scheme, item.profile));
    if (combination.chain) {
        const fronts = combination.fronts.filter(node => !excludedFronts.has(node.tag));
        if (!fronts.length) throw new InvalidConfigError('No compatible front nodes are available for this v2rayN/v2rayNG output');
        if (fronts.length * combination.landings.length > 2000) {
            throw new InvalidConfigError('Too many chain combinations; use fewer front or landing nodes');
        }
        let index = 0;
        for (const front of fronts) {
            for (const landing of combination.landings) {
                links.push(shareLink('proxychain', {
                    IndexId: 'chain-' + index++,
                    ConfigType: 102,
                    ConfigVersion: 4,
                    CoreType: 2,
                    Remarks: '链式 · ' + front.tag + ' → ' + landing.tag,
                    ProtoExtraObj: { ChildItems: byName.get(front.tag).IndexId + ',' + byName.get(landing.tag).IndexId }
                }));
            }
        }
    }
    return { content: encodeBase64(links.join('\n')), excludedFrontCount: excludedFronts.size };
}
