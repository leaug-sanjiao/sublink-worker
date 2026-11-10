import { BaseConfigBuilder } from '../builders/BaseConfigBuilder.js';
import { addProxyWithDedup } from '../builders/helpers/proxyHelpers.js';
import { InvalidConfigError } from './errors.js';

const FRONT_GROUP = '前置线路';
const ORIGINAL_GROUP = '原订阅节点';

function accountKey(node) {
    return JSON.stringify([node.type, node.server?.toLowerCase(), node.server_port,
        node.uuid, node.username, node.password, node.method]);
}

function identityKey(node) {
    return JSON.stringify([
        node.type, node.server, node.server_port, node.uuid, node.username, node.password,
        node.method, node.transport, node.tls, node.flow, node.plugin, node.plugin_opts
    ]);
}

async function parseNodes(input, prefix, userAgent) {
    if (!input?.trim()) return { nodes: [] };
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
    return { nodes, subscriptionUserinfo: parser.subscriptionUserinfo };
}

export async function resolveNodeCombinations({ input, fixedInput, landingInput, defaultFixedInput, chain, chainFixedExits, userAgent }) {
    const [originalSource, manualSource, landingSource, defaultSource] = await Promise.all([
        parseNodes(input, chain || chainFixedExits ? '前置 · ' : '原订阅 · ', userAgent),
        parseNodes(fixedInput, '', userAgent),
        parseNodes(landingInput, '落地 · ', userAgent),
        parseNodes(defaultFixedInput, '', userAgent)
    ]);
    const originalNodes = originalSource.nodes;
    const manualFixed = manualSource.nodes;
    const landings = landingSource.nodes;
    const defaults = defaultSource.nodes;
    const defaultAccounts = new Set(defaults.map(accountKey));
    const fronts = originalNodes.filter(node => !defaultAccounts.has(accountKey(node)));
    // Preserve a single source's chosen exit when adding more choices to its subscription.
    const preferred = originalNodes.length === 1 && defaults.find(node => accountKey(node) === accountKey(originalNodes[0]));
    const fixed = preferred ? [preferred, ...defaults.filter(node => node !== preferred)] : [...defaults];
    manualFixed.forEach(node => {
        if (!defaultAccounts.has(accountKey(node))) fixed.push(node);
    });
    if (chain && (!fronts.length || !landings.length)) {
        throw new InvalidConfigError('Chain mode requires both front nodes and standalone landing nodes');
    }
    const nodes = [...fixed, ...fronts, ...landings];
    if (new Set(nodes.map(identityKey)).size !== nodes.length) {
        throw new InvalidConfigError('The same node cannot be used as both a front, fixed exit or landing');
    }
    const chainTargets = [...(chain ? landings : []), ...(chainFixedExits && fronts.length ? defaults : [])];
    const chainNodes = chainTargets.map(node => ({
        ...node,
        tag: '链式 · ' + (node.tag.startsWith('落地 · ') ? node.tag.slice('落地 · '.length) : node.tag),
        detour: FRONT_GROUP
    }));
    nodes.push(...chainNodes);
    const names = nodes.map(node => node.tag);
    if (new Set(names).size !== names.length || names.includes(FRONT_GROUP) || names.includes(ORIGINAL_GROUP)) {
        throw new InvalidConfigError('Combination node names must be unique');
    }
    return {
        nodes,
        subscriptionUserinfo: originalSource.subscriptionUserinfo,
        fronts,
        fixed,
        landings,
        chainNodes,
        chainTargets,
        chain: chainTargets.length > 0,
        originalGroup: fronts.length ? ORIGINAL_GROUP : null,
        groups: [
            ...(fronts.length ? [{ name: ORIGINAL_GROUP, type: 'select', proxies: fronts.map(node => node.tag) }] : []),
            ...(chainTargets.length ? [{ name: FRONT_GROUP, type: 'select', proxies: fronts.map(node => node.tag) }] : [])
        ]
    };
}
