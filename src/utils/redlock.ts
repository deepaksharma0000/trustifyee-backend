// src/utils/redlock.ts
import Redlock from "redlock";
import { redisConnection } from "./redis";

const redlock = new Redlock(
    [redisConnection],
    {
        driftFactor: 0.01,
        retryCount: 10,
        retryDelay: 200,
        retryJitter: 200,
        automaticExtensionThreshold: 500,
    }
);

export default redlock;
