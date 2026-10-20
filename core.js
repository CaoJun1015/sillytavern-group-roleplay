export const DATA_VERSION = 1;
export const PLAYER = 'player';
const MAX_PLAYER_TEXT = 4000;
const MAX_NPC_TEXT = 2000;

const copy = value => structuredClone(value);
const id = () => crypto.randomUUID();

export function createSession(groupId, chatId, members, { startTime = new Date().toISOString(), minutes = 1 } = {}) {
    if (!groupId || !chatId || !Array.isArray(members) || !members.length ||
        !Number.isInteger(minutes) || minutes < 1 || minutes > 60 || !Number.isFinite(Date.parse(startTime))) {
        throw new Error('无效的会话设置');
    }
    return {
        version: DATA_VERSION, id: id(), branchId: id(), revision: 0, groupId, chatId,
        members: [...new Set(members)], channel: 'group', minutes, pending: null, rounds: [],
        state: {
            time: startTime, playerFacts: [],
            npcs: Object.fromEntries(members.map(member => [member, {
                facts: [], relation: '陌生', relationEvents: [], body: '未知', bodySource: null,
            }])),
        },
    };
}

export function audience(session, channel = session.channel) {
    if (channel === 'group') return [PLAYER, ...session.members];
    const member = channel.startsWith('private:') && channel.slice(8);
    if (member && session.members.includes(member)) return [PLAYER, member];
    throw new Error('无效的频道');
}

export function makeMessage(session, roundId, speaker, text, channel = session.channel) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('消息不能为空');
    const allowed = audience(session, channel);
    if (speaker !== PLAYER && !allowed.includes(speaker)) throw new Error('发言人不在频道内');
    const limit = speaker === PLAYER ? MAX_PLAYER_TEXT : MAX_NPC_TEXT;
    if (text.length > limit || /<\/?[a-z][^>]*>/i.test(text)) throw new Error('消息过长或包含 HTML');
    return {
        id: id(), roundId, channel, speaker, text: text.trim(), time: session.state.time,
        audience: allowed,
    };
}

export function beginRound(session, messages, input = '', target = null) {
    if (session.pending) throw new Error('上一轮尚未完成');
    if (target && !audience(session).includes(target)) throw new Error('点名对象不在当前频道');
    if (typeof input !== 'string' || input.length > MAX_PLAYER_TEXT) throw new Error('玩家输入无效');
    const next = copy(session);
    const roundId = id();
    const playerMessage = input.trim() ? makeMessage(next, roundId, PLAYER, input) : null;
    next.pending = { id: roundId, channel: next.channel, target, inputId: playerMessage?.id ?? null, before: copy(next.state) };
    next.revision++;
    return { session: next, messages: playerMessage ? [...messages, playerMessage] : [...messages] };
}

export function visibleMessages(messages, recipient) {
    return messages.filter(message => message.audience?.includes(recipient));
}

export function forbiddenInRequest(messages, recipient, channel, mode, requestBody) {
    const publicForRequest = mode === '调度' && channel === 'group'
        ? messages.filter(message => message.channel === 'group')
        : visibleMessages(messages, recipient);
    const fields = [requestBody];
    try {
        const visit = value => {
            if (typeof value === 'string') fields.push(value);
            else if (value && typeof value === 'object') Object.values(value).forEach(visit);
        };
        visit(JSON.parse(requestBody));
    } catch { /* Non-JSON request bodies still get the raw check. */ }
    return messages.find(message => message.text &&
        (mode === '调度' && channel === 'group'
            ? message.channel !== 'group'
            : !message.audience.includes(recipient)) &&
        !publicForRequest.some(visible => visible.text.includes(message.text)) &&
        fields.some(field => field.includes(message.text)));
}

export function sameTurn(ticket, currentEpoch, binding, session) {
    return ticket === currentEpoch && !!session.pending &&
        binding === `${session.id}/${session.branchId}/${session.revision}/${session.pending.id}`;
}

export async function saveGroupSnapshot(fetcher, headers, chatId, chat) {
    const response = await fetcher('/api/chats/group/save', {
        method: 'POST', headers, body: JSON.stringify({ id: chatId, chat }),
    });
    if (!response.ok) throw new Error(`群聊保存失败：HTTP ${response.status}`);
    if (!(await response.json()).ok) throw new Error('群聊保存失败：响应未确认');
}

export function knownState(session, recipient) {
    const own = session.state.npcs[recipient];
    if (!own) throw new Error('未知角色');
    return {
        time: session.state.time, playerFacts: session.state.playerFacts.filter(f => f.knownBy.includes(recipient)),
        own: copy(own),
        knownOtherFacts: Object.entries(session.state.npcs).flatMap(([member, value]) =>
            value.facts.filter(f => f.knownBy.includes(recipient)).map(f => ({ member, ...f }))),
    };
}

export function contextFor(session, messages, recipient, maxChars = 12000) {
    const visible = visibleMessages(messages, recipient);
    const state = knownState(session, recipient);
    state.playerFacts = state.playerFacts.slice(-20);
    state.own.facts = state.own.facts.slice(-20);
    state.own.relationEvents = state.own.relationEvents.slice(-10);
    state.knownOtherFacts = state.knownOtherFacts.slice(-20);
    while (JSON.stringify(state).length > maxChars / 2) {
        const lists = [state.knownOtherFacts, state.playerFacts, state.own.facts, state.own.relationEvents];
        const largest = lists.sort((a, b) => b.length - a.length)[0];
        if (!largest.length) break;
        largest.shift();
    }
    const recent = [];
    let used = JSON.stringify(state).length;
    for (let index = visible.length - 1; index >= 0; index--) {
        const message = visible[index];
        if (!recent.length && message.text.length > maxChars) throw new Error('最新消息超出上下文预算');
        if (used + message.text.length > maxChars) break;
        recent.unshift({ id: message.id, speaker: message.speaker, channel: message.channel, text: message.text });
        used += message.text.length;
    }
    // Older dialogue is omitted; accepted facts above retain their source IDs and audience.
    return { state, messages: recent };
}

export function parseJson(text) {
    if (typeof text !== 'string' || text.length > 30000) throw new Error('模型结果无效');
    return JSON.parse(text.trim());
}

export function validatePlan(plan, session) {
    if (!plan || Object.keys(plan).some(key => !['intent', 'target', 'clarify', 'speakers', 'playerFacts'].includes(key)) ||
        typeof plan.intent !== 'string' || plan.intent.length > 100 ||
        (plan.target !== null && plan.target !== undefined && !audience(session).includes(plan.target)) ||
        (plan.clarify !== undefined && typeof plan.clarify !== 'boolean') ||
        !Array.isArray(plan.speakers) || plan.speakers.length > 3) throw new Error('发言计划无效');
    if (plan.playerFacts !== undefined && (!Array.isArray(plan.playerFacts) || plan.playerFacts.length > 5 ||
        plan.playerFacts.some(fact => !fact || typeof fact.value !== 'string' || typeof fact.quote !== 'string' ||
            fact.value.length > 100 || fact.quote.length > 250))) throw new Error('玩家资料提取无效');
    const allowed = audience(session).filter(member => member !== PLAYER);
    if (new Set(plan.speakers).size !== plan.speakers.length || plan.speakers.some(member => !allowed.includes(member))) {
        throw new Error('发言计划含非法成员');
    }
    return plan.speakers;
}

export function validateReply(reply, session, speaker) {
    if (!reply || Object.keys(reply).some(key => !['action', 'text', 'changes'].includes(key)) ||
        !['reply', 'silent'].includes(reply.action) || typeof reply.text !== 'string' || !Array.isArray(reply.changes)) {
        throw new Error('角色结果结构无效');
    }
    const keys = new Set(['kind', 'subject', 'value', 'sourceId', 'quote', 'confidence']);
    if (reply.changes.length > 8 || reply.changes.some(change => !change ||
        Object.keys(change).some(key => !keys.has(key)) ||
        !['player_fact', 'npc_fact', 'relation', 'body'].includes(change.kind) ||
        typeof change.subject !== 'string' || typeof change.value !== 'string' ||
        typeof change.sourceId !== 'string' || typeof change.quote !== 'string' ||
        !['explicit', 'uncertain'].includes(change.confidence))) {
        throw new Error('状态变更结构无效');
    }
    if (reply.action === 'silent') {
        if (reply.text || reply.changes.length) throw new Error('沉默结果不能修改状态');
        return null;
    }
    if (/^(?:玩家|用户|user|you)\s*[:：]/i.test(reply.text)) throw new Error('疑似代写玩家台词');
    return makeMessage(session, session.pending.id, speaker, reply.text, session.pending.channel);
}

export function applyChanges(state, changes, messages, speaker) {
    const next = copy(state);
    const byId = new Map(messages.map(message => [message.id, message]));
    for (const change of changes) {
        if (!change || !['player_fact', 'npc_fact', 'relation', 'body'].includes(change.kind) ||
            typeof change.value !== 'string' || !change.value.trim() || change.value.length > 200 ||
            typeof change.quote !== 'string' || !change.quote.trim() || change.quote.length > 250 ||
            change.confidence !== 'explicit') continue;
        const source = byId.get(change.sourceId);
        if (!source || !source.text.includes(change.quote) || !change.quote.includes(change.value) ||
            !source.audience.includes(PLAYER)) continue;
        if (change.kind === 'player_fact') {
            if (source.speaker !== PLAYER || change.subject !== PLAYER) continue;
            if (!next.playerFacts.some(f => f.value === change.value)) next.playerFacts.push({
                value: change.value, sourceId: source.id, knownBy: [...source.audience],
            });
            continue;
        }
        if (change.subject !== speaker || !next.npcs[speaker]) continue;
        const own = next.npcs[speaker];
        if (change.kind === 'npc_fact') {
            if (source.speaker !== speaker) continue;
            if (!own.facts.some(f => f.value === change.value)) own.facts.push({
                value: change.value, sourceId: source.id, knownBy: [...source.audience],
            });
        } else if (change.kind === 'body') {
            if (source.speaker !== speaker) continue;
            own.body = change.value;
            own.bodySource = source.id;
        } else if (change.kind === 'relation') {
            if (!source.audience.includes(speaker)) continue;
            own.relation = change.value;
            own.relationEvents.push({ value: change.value, sourceId: source.id });
        }
    }
    return next;
}

export function completeRound(session, messages, replies, playerChanges = []) {
    if (!session.pending) throw new Error('没有待完成回合');
    const next = copy(session);
    const all = [...messages];
    next.state = applyChanges(next.state, playerChanges, all, PLAYER);
    for (const { speaker, reply, message } of replies) {
        if (message) {
            if (message.speaker !== speaker || message.roundId !== next.pending.id) throw new Error('回合消息不匹配');
            all.push(message);
            next.state = applyChanges(next.state, reply.changes, all, speaker);
        }
    }
    next.state.time = new Date(Date.parse(next.state.time) + next.minutes * 60000).toISOString();
    next.rounds.push({
        id: next.pending.id, channel: next.pending.channel, before: next.pending.before,
        messageIds: all.filter(message => message.roundId === next.pending.id).map(message => message.id),
        after: copy(next.state),
    });
    next.pending = null;
    next.revision++;
    return { session: next, messages: all };
}

export function rewind(session, messages, roundId, retry = false) {
    const index = session.rounds.findIndex(round => round.id === roundId);
    if (index < 0) throw new Error('找不到回合');
    const next = copy(session);
    const discarded = next.rounds.slice(index);
    const removed = new Set(discarded.map(round => round.id));
    const first = discarded[0];
    next.state = copy(first.before);
    next.rounds.length = index;
    next.revision++;
    next.branchId = id();
    next.channel = first.channel;
    const kept = messages.filter(message => !removed.has(message.roundId) ||
        (retry && message.roundId === roundId && message.speaker === PLAYER));
    next.pending = retry ? {
        id: roundId, channel: first.channel, target: null,
        inputId: kept.find(message => message.roundId === roundId && message.speaker === PLAYER)?.id ?? null,
        before: copy(first.before),
    } : null;
    return { session: next, messages: kept, discarded };
}

export function recover(session, messages) {
    if (session.version !== DATA_VERSION) throw new Error('不支持的存档版本');
    const next = copy(session);
    let valid = 0;
    for (const round of next.rounds) {
        if (!round.messageIds.every(messageId => messages.some(message => message.id === messageId))) break;
        valid++;
    }
    if (valid < next.rounds.length) {
        next.state = copy(next.rounds[valid].before);
        next.rounds.length = valid;
        next.pending = null;
    }
    if (next.pending?.inputId && !messages.some(message => message.id === next.pending.inputId)) next.pending = null;
    const allowed = new Set(next.rounds.flatMap(round => round.messageIds));
    if (next.pending?.inputId) allowed.add(next.pending.inputId);
    return { session: next, messages: messages.filter(message => allowed.has(message.id)) };
}
