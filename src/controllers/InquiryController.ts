import { Request, Response } from 'express';
import Inquiry from '../models/Inquiry';
import Joi from 'joi';

const inquirySchema = Joi.object({
    full_name: Joi.string().min(3).max(100).required(),
    email: Joi.string().email().required(),
    mobile_number: Joi.string().pattern(/^[0-9]{10,15}$/).required()
});

export const postInquiry = async (req: Request, res: Response) => {
    try {
        const { error } = inquirySchema.validate(req.body);
        if (error) return res.status(400).json({ error: error.message, status: false });

        const { full_name, email, mobile_number } = req.body;

        const existing = await Inquiry.findOne({ $or: [{ email }, { mobile_number }] });
        if (existing) return res.status(400).json({ error: "Email or mobile number already submitted.", status: false });

        const newInquiry = new Inquiry({ full_name, email, mobile_number });
        await newInquiry.save();

        res.status(201).json({
            message: "Inquiry submitted successfully!",
            data: newInquiry,
            status: true
        });

    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
}

export const getInquiries = async (req: Request, res: Response) => {
    try {
        const inquiries = await Inquiry.find();
        res.status(200).json({
            message: "Inquiries fetched successfully!",
            data: inquiries,
            status: true
        });
    } catch (err: any) {
        res.status(500).json({ error: err.message, status: false });
    }
}
