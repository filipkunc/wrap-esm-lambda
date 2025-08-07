import './wrap.mjs';

const rssBefore = process.memoryUsage.rss();
const handlerModule = await import('./handler.mjs');
const handler = handlerModule.handler;
const rssAfter = process.memoryUsage.rss();

const maxRss = Math.max(rssBefore, rssAfter);

const res = await handler({ foo: 'bar' }, {});
console.log(`${res}\nmaxRss: ${maxRss / (1024 * 1024) } MB`);
