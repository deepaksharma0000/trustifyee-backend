"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InstrumentScheduler = void 0;
// src/services/scheduler.ts
const cron_1 = require("cron");
const upstoxInstrumentService_1 = require("./upstoxInstrumentService");
const logger_1 = require("../utils/logger");
class InstrumentScheduler {
    constructor() {
        this.instrumentService = new upstoxInstrumentService_1.UpstoxInstrumentService();
    }
    /**
     * Schedule daily BOD instrument sync (run at 6:00 AM every day)
     */
    scheduleDailyBodSync() {
        const job = new cron_1.CronJob('0 6 * * *', // 6:00 AM every day
        async () => {
            try {
                logger_1.log.info('Starting scheduled BOD instrument sync...');
                await this.instrumentService.syncBodInstruments('complete');
                logger_1.log.info('Scheduled BOD instrument sync completed');
            }
            catch (error) {
                logger_1.log.error('Scheduled BOD sync failed:', error);
            }
        }, null, // onComplete
        true, // start
        'Asia/Kolkata');
        logger_1.log.info('BOD instrument sync scheduled for 6:00 AM daily');
        return job;
    }
    /**
     * Manual sync (can be called from CLI or API)
     */
    async manualSync() {
        try {
            logger_1.log.info('Starting manual BOD instrument sync...');
            const result = await this.instrumentService.syncBodInstruments('complete');
            logger_1.log.info('Manual BOD sync completed:', result);
            return result;
        }
        catch (error) {
            logger_1.log.error('Manual sync failed:', error);
            throw error;
        }
    }
}
exports.InstrumentScheduler = InstrumentScheduler;
// Initialize scheduler in index.ts
// const scheduler = new InstrumentScheduler();
// scheduler.scheduleDailyBodSync();
