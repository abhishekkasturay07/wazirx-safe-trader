import { assertSafeConfiguration } from '../config.js';
import { scan } from '../jobs/scanner.js';
assertSafeConfiguration();
console.log(JSON.stringify(await scan(), null, 2));
