// Zod 4 compiles a faster parser with `new Function` unless told not to, and
// its probe for that runs when an object schema is built. The CSP has no
// 'unsafe-eval' (A§12.2), so even the caught probe is a securitypolicyviolation.
// main.tsx imports this module first, before @rws/contracts builds any schema.
import { config } from 'zod';

config({ jitless: true });
