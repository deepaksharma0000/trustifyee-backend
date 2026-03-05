import { Request, Response } from 'express';
import { SubscriptionRequest } from '../models/SubscriptionRequest';
import User from '../models/User';
import { log } from '../utils/logger';

export const submitSubscriptionRequest = async (req: Request, res: Response) => {
    try {
        const { planId, planName, amount, durationMonths, transactionId } = req.body;
        const userId = (req as any).id;
        const user = await User.findById(userId);

        if (!user) {
            return res.status(404).json({ ok: false, message: 'User not found' });
        }

        // Check if a pending request already exists for this transaction ID
        const existing = await SubscriptionRequest.findOne({ transactionId });
        if (existing) {
            return res.status(400).json({ ok: false, message: 'This Transaction ID has already been submitted' });
        }

        const newRequest = await SubscriptionRequest.create({
            userId: user._id,
            userName: user.user_name,
            planId,
            planName,
            amount,
            durationMonths,
            transactionId,
            status: 'PENDING'
        });

        log.info(`Subscription request submitted by ${user.user_name} for plan ${planName}`);

        res.json({ ok: true, message: 'Request submitted successfully. Admin will verify and activate your Live licence soon.', data: newRequest });
    } catch (error: any) {
        log.error('Error submitting subscription request:', error);
        res.status(500).json({ ok: false, message: error.message });
    }
};

export const getMyRequests = async (req: Request, res: Response) => {
    try {
        const userId = (req as any).id;
        const requests = await SubscriptionRequest.find({ userId }).sort({ createdAt: -1 });
        res.json({ ok: true, data: requests });
    } catch (error: any) {
        res.status(500).json({ ok: false, message: error.message });
    }
};

export const getAllRequestsAdmin = async (req: Request, res: Response) => {
    try {
        const requests = await SubscriptionRequest.find().sort({ createdAt: -1 });
        res.json({ ok: true, data: requests });
    } catch (error: any) {
        res.status(500).json({ ok: false, message: error.message });
    }
};

export const processSubscriptionAdmin = async (req: Request, res: Response) => {
    try {
        const { requestId, action, remarks } = req.body; // action: 'APPROVE' or 'REJECT'

        const subRequest = await SubscriptionRequest.findById(requestId);
        if (!subRequest) {
            return res.status(404).json({ ok: false, message: 'Request not found' });
        }

        if (subRequest.status !== 'PENDING') {
            return res.status(400).json({ ok: false, message: 'Request already processed' });
        }

        if (action === 'APPROVE') {
            subRequest.status = 'APPROVED';
            subRequest.adminRemarks = remarks;
            await subRequest.save();

            // Update User License to Live and update end_date
            const user = await User.findById(subRequest.userId);
            if (user) {
                user.licence = 'Live';
                user.broker_verified = true; // Auto verify broker on payment approval

                const now = new Date();
                const currentEndDate = (user.end_date && user.end_date > now) ? user.end_date : now;

                const newEndDate = new Date(currentEndDate);
                newEndDate.setMonth(newEndDate.getMonth() + subRequest.durationMonths);

                user.start_date = user.start_date || now;
                user.end_date = newEndDate;
                user.status = 'active';

                await user.save();
                log.info(`Admin approved subscription for ${user.user_name}. Licence set to LIVE until ${newEndDate.toLocaleDateString()}`);
            }
        } else {
            subRequest.status = 'REJECTED';
            subRequest.adminRemarks = remarks;
            await subRequest.save();
            log.info(`Admin rejected subscription for user ID ${subRequest.userId}`);
        }

        res.json({ ok: true, message: `Request ${action === 'APPROVE' ? 'Approved' : 'Rejected'} successfully` });
    } catch (error: any) {
        log.error('Error processing subscription request:', error);
        res.status(500).json({ ok: false, message: error.message });
    }
};
