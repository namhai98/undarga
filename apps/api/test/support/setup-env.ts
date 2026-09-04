// Runs in `setupFiles`, before the module registry — so ConfigModule sees the
// test database URLs at import time.
import { applyTestDatabaseEnv } from './test-env';

applyTestDatabaseEnv();
