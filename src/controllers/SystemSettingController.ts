import { Request, Response } from 'express';
import { SystemSetting } from '../models/SystemSetting';
import User from '../models/User';
import log from '../utils/logger';

export const getGlobalTradingStatus = async (req: Request, res: Response) => {
    try {
        let setting = await SystemSetting.findOne({ key: 'global_trading_status' });
        if (!setting) {
            setting = await SystemSetting.create({
                key: 'global_trading_status',
                value: 'enabled',
                description: 'Trading Kill Switch (Global Status)'
            });
        }
        res.status(200).json({ status: true, data: setting.value });
    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
}

export const updateGlobalTradingStatus = async (req: Request, res: Response) => {
    try {
        const { value } = req.body;
        if (!['enabled', 'disabled'].includes(value)) {
            return res.status(400).json({ error: "Invalid status value", status: false });
        }

        const setting = await SystemSetting.findOneAndUpdate(
            { key: 'global_trading_status' },
            { $set: { value: value } },
            { new: true, upsert: true }
        );

        log.info(`[SYSTEM_SETTING] Global Trading Status updated to: ${value}`);
        res.status(200).json({ status: true, message: `Global trading status is now ${value}`, data: setting.value });
    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
}

export const getActiveTradingUsers = async (req: Request, res: Response) => {
    try {
        const users = await User.find({
            status: 'active',
            trading_status: 'enabled'
        }).select('user_name email phone_number licence broker broker_verified created_at last_login').lean();

        res.status(200).json({ status: true, data: users });
    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
}
