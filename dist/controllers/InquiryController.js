"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getInquiries = exports.postInquiry = void 0;
const Inquiry_1 = __importDefault(require("../models/Inquiry"));
const joi_1 = __importDefault(require("joi"));
const inquirySchema = joi_1.default.object({
    full_name: joi_1.default.string().min(3).max(100).required(),
    email: joi_1.default.string().email().required(),
    mobile_number: joi_1.default.string().pattern(/^[0-9]{10,15}$/).required()
});
const postInquiry = async (req, res) => {
    try {
        const { error } = inquirySchema.validate(req.body);
        if (error)
            return res.status(400).json({ error: error.message, status: false });
        const { full_name, email, mobile_number } = req.body;
        const existing = await Inquiry_1.default.findOne({ $or: [{ email }, { mobile_number }] });
        if (existing)
            return res.status(400).json({ error: "Email or mobile number already submitted.", status: false });
        const newInquiry = new Inquiry_1.default({ full_name, email, mobile_number });
        await newInquiry.save();
        res.status(201).json({
            message: "Inquiry submitted successfully!",
            data: newInquiry,
            status: true
        });
    }
    catch (err) {
        res.status(500).json({ error: err.message, status: false });
    }
};
exports.postInquiry = postInquiry;
const getInquiries = async (req, res) => {
    try {
        const inquiries = await Inquiry_1.default.find();
        res.status(200).json({
            message: "Inquiries fetched successfully!",
            data: inquiries,
            status: true
        });
    }
    catch (err) {
        res.status(500).json({ error: err.message, status: false });
    }
};
exports.getInquiries = getInquiries;
