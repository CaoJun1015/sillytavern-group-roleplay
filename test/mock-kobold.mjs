import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const port = 50555;
const logFile = path.resolve('test-results/mock-requests.jsonl');
fs.mkdirSync(path.dirname(logFile), { recursive: true });

http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const send = value => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
    };
    const route = request.url.replace(/^\/api/, '');
    if (route === '/v1/info/version') return send({ result: '1.2.0' });
    if (route === '/extra/version') return send({ version: '1.0.0' });
    if (route === '/v1/model') return send({ result: 'PlainGroupAcceptanceMock' });
    if (route !== '/v1/generate') {
        response.writeHead(404).end();
        return;
    }
    fs.appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), prompt: body.prompt })}\n`);
    const prompt = String(body.prompt || '');
    if (prompt.includes('测试延迟')) await new Promise(resolve => setTimeout(resolve, 5000));
    if (prompt.includes('坏JSON')) return send({ results: [{ text: '{bad json' }] });
    if (prompt.includes('你是群聊回合调度器')) {
        const members = [...prompt.matchAll(/"id":"([^"]+\.png)","name":"([^"]+)"/g)].map(match => match[1]);
        const speakers = prompt.includes('全员沉默') ? [] : members.slice(0, 2);
        return send({ results: [{ text: JSON.stringify({ intent: '测试', target: null, clarify: false, speakers, playerFacts: [] }) }] });
    }
    const name = /你只扮演 ([^。]+)。/.exec(prompt)?.[1] || '测试角色';
    return send({ results: [{ text: JSON.stringify({ action: 'reply', text: `${name}：收到。`, changes: [] }) }] });
}).listen(port, '127.0.0.1', () => console.log(`mock KoboldAI listening on 127.0.0.1:${port}`));
