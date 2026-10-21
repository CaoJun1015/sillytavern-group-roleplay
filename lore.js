// Only the selected books are read. A character's own books never enter another
// character's request, even when both characters belong to the same group.
export function bookNamesFor({ global = [], chat = '', primary = '', extra = [] }) {
    return [...new Set([...global, chat, primary, ...extra].filter(Boolean))];
}

export function visibleMessagesFor(messages, member) {
    return messages.filter(message => message.audience?.includes(member));
}

function matches(key, text, caseSensitive = false) {
    if (typeof key !== 'string' || !key) return false;
    const regex = key.match(/^\/(.*)\/([a-z]*)$/i);
    if (regex) {
        try { return new RegExp(regex[1], regex[2]).test(text); }
        catch { throw new Error(`世界书关键词正则无效：${key}`); }
    }
    return caseSensitive ? text.includes(key) : text.toLocaleLowerCase().includes(key.toLocaleLowerCase());
}

export function selectLore(books, visibleMessages, { maxChars = 4000, scanDepth = 4, random = Math.random } = {}) {
    const scan = visibleMessages.slice(-scanDepth).map(message => `${message.speaker}: ${message.text}`).join('\n');
    const selected = [];
    const skipped = [];
    let used = 0;
    for (const book of books) {
        for (const entry of Object.values(book.entries || {})) {
            if (entry.disable || !entry.content) continue;
            const label = `${book.name}/${entry.comment || entry.uid || '?'}`;
            if (entry.vectorized || entry.delayUntilRecursion || entry.sticky || entry.cooldown || entry.delay ||
                entry.characterFilter?.names?.length || entry.characterFilter?.tags?.length ||
                /^@@/m.test(entry.content)) {
                skipped.push(`${label}（高级激活条件暂不支持）`);
                continue;
            }
            const keys = Array.isArray(entry.key) ? entry.key : [];
            const secondary = Array.isArray(entry.keysecondary) ? entry.keysecondary : [];
            const caseSensitive = entry.caseSensitive === true;
            const primaryHit = keys.some(key => matches(key, scan, caseSensitive));
            const secondaryHits = secondary.map(key => matches(key, scan, caseSensitive));
            const logic = Number(entry.selectiveLogic ?? 0);
            const secondaryHit = !entry.selective || !secondary.length ||
                (logic === 0 && secondaryHits.some(Boolean)) ||
                (logic === 1 && !secondaryHits.every(Boolean)) ||
                (logic === 2 && !secondaryHits.some(Boolean)) ||
                (logic === 3 && secondaryHits.every(Boolean));
            if (!entry.constant && !(primaryHit && secondaryHit)) continue;
            if (entry.useProbability && Number(entry.probability ?? 100) < random() * 100) continue;
            const content = String(entry.content).trim();
            if (used + content.length > maxChars) { skipped.push(`${label}（超出世界书预算）`); continue; }
            selected.push({ book: book.name, content });
            used += content.length;
        }
    }
    return { selected, skipped };
}

export function panelRules(mainApi, systemPreset, promptManager, character = null) {
    if (mainApi !== 'openai') {
        return systemPreset?.enabled ? [systemPreset.content, systemPreset.post_history].filter(Boolean) : [];
    }
    if (!promptManager?.activeCharacter) return [];
    return promptManager.getPromptOrderForCharacter(promptManager.activeCharacter)
        .filter(item => item.enabled)
        .map(item => promptManager.getPromptById(item.identifier))
        .filter(prompt => prompt && !prompt.marker && promptManager.shouldTrigger(prompt, 'quiet'))
        .map(prompt => {
            if (!prompt.forbid_overrides && prompt.identifier === 'main' && character?.system_prompt) return character.system_prompt;
            if (!prompt.forbid_overrides && prompt.identifier === 'jailbreak' && character?.post_history_instructions) return character.post_history_instructions;
            return prompt.content;
        }).filter(Boolean);
}

export function safeSettingsText(value, { character, player, group }) {
    const replacements = { char: character, charIfNotGroup: character, user: player, group };
    const result = String(value).replace(/{{\s*([\w]+)\s*}}/g, (macro, name) => {
        if (!(name in replacements)) throw new Error(`配置包含未支持的宏：${macro}`);
        return replacements[name] || '';
    });
    if (result.includes('{{')) throw new Error('配置包含未支持的宏');
    return result;
}
