// Child process for main.test.ts: installs the capture role's process
// handlers, then raises an unhandled rejection and an uncaught exception
// whose messages carry a dummy key. It must stay alive and log fixed fields.
import { keepAlive } from '../src/main.ts';

keepAlive({ error: (o: unknown, m?: string) => console.log(JSON.stringify({ o, m })) });
Promise.reject(new Error('https://hc-ping.com/DUMMYKEY0123456789/cap-nl'));
setTimeout(() => {
  throw Object.assign(new Error('socket DUMMYKEY0123456789'), { code: 'ECONNRESET' });
}, 10);
setTimeout(() => console.log('alive'), 100);
