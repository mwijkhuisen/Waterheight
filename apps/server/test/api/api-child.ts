// Child process for routes.int.test.ts: runs the api role of main.ts, asks it
// for /api/v1/meta the moment it listens, then stops it as a SIGTERM does.
// Prints one JSON line with that answer and one with the exit code.
import { run } from '../../src/main.ts';

const code = await run(['api'], process.env, (line) => {
  if (!line.startsWith('api listening')) return;
  void fetch(`http://127.0.0.1:${process.env.PORT}/api/v1/meta`).then(async (res) => {
    console.log(JSON.stringify({ status: res.status, body: await res.text() }));
    process.kill(process.pid, 'SIGTERM');
  });
});
console.log(JSON.stringify({ exit: code }));
