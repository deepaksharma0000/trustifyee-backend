import { redisConnection } from "./redis";

type LockHandle = {
    release: () => Promise<void>;
};

class SimpleRedlock {
    async acquire(resources: string[], ttlMs: number): Promise<LockHandle> {
        const resource = resources[0];
        if (!resource) throw new Error("Lock resource is required");

        const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const lockResult = await redisConnection.set(resource, token, "PX", ttlMs, "NX");
        if (lockResult !== "OK") {
            throw new Error(`LOCK_NOT_ACQUIRED:${resource}`);
        }

        let released = false;
        return {
            release: async () => {
                if (released) return;
                released = true;
                const script = [
                    "if redis.call('get', KEYS[1]) == ARGV[1] then",
                    "  return redis.call('del', KEYS[1])",
                    "else",
                    "  return 0",
                    "end",
                ].join("\n");
                await redisConnection.eval(script, 1, resource, token);
            },
        };
    }
}

const redlock = new SimpleRedlock();
export default redlock;
