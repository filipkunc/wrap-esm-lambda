import './wrap.mjs';
import { handler } from './handler.mjs';

const res = await handler({ foo: 'bar' }, {});
console.log(res);
