import { BaseConfigBuilder } from '../builders/BaseConfigBuilder.js';
import { addProxyWithDedup } from '../builders/helpers/proxyHelpers.js';
import { InvalidConfigError } from './errors.js';

const FRONT_GROUP = '前置线路';

function identityKey(node) {
    return JSON.stringify([
        node.type, node.server, node.server_port, node.uuid, node.username, node.password,
        node.method, node.transport, node.tls, node.flow, node.plugin, node.plugin_opts
    ]);
}

async function parseNodes(input, prefix, userAgent) {
    if (!input?.trim()) return [];
    const parser = new BaseConfigBuilder(input, {}, 'zh-CN', userAgent, false, false);
    const parsed = await parser.parseCustomItems();
    if (!parsed.length) throw new InvalidConfigError('The supplied node source has no supported nodes');
    const nodes = [];
    for (const node of parsed) {
        if (!node.server || !Number.isInteger(node.server_port) || node.server_port < 1 || node.server_port > 65535) {
            throw new InvalidConfigError('Combination nodes require a server and valid port');
        }
        if (node.detour) {
            throw new InvalidConfigError('Use standalone nodes as combination inputs; pre-chained nodes are not accepted');
        }
        addProxyWithDedup(nodes, { ...node, tag: prefix + node.tag }, {
            isSame: (a, b) => identityKey(a) === identityKey(b)
        });
    }
    return nodes;
}

export async function resolveNodeCombinations({ input, fixedInput, landingInput, chain, userAgent }) {
    const [fronts, fixed, landings] = await Promise.all([
        parseNodes(input, '前置 · ', userAgent),
        parseNodes(fixedInput, '', userAgent),
        parseNodes(landingInput, '落地 · ', userAgent)
    ]);
    if (chain && (!fronts.length || !landings.length)) {
        throw new InvalidConfigError('Chain mode requires both front nodes and standalone landing nodes');
    }
    const nodes = [...fixed, ...fronts, ...landings];
    if (new Set(nodes.map(identityKey)).size !== nodes.length) {
        throw new InvalidConfigError('The same node cannot be used as both a front, fixed exit or landing');
    }
    const chainNodes = chain ? landings.map(node => ({
        ...node,
        tag: '链式 · ' + node.tag.slice('落地 · '.length),
        detour: FRONT_GROUP
    })) : [];
    nodes.push(...chainNodes);
    const names = nodes.map(node => node.tag);
    if (new Set(names).size !== names.length || names.includes(FRONT_GROUP)) {
        throw new InvalidConfigError('Combination node names must be unique');
    }
    return {
        nodes,
        fronts,
        landings,
        chain,
        groups: chain ? [{ name: FRONT_GROUP, type: 'select', proxies: fronts.map(node => node.tag) }] : []
    };
}
