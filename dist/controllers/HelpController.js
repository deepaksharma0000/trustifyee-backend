"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HelpController = void 0;
const nodemailer_1 = __importDefault(require("nodemailer"));
class HelpController {
    static async submitRequest(req, res) {
        try {
            const { username, fullName, mobile, email, message } = req.body;
            if (!username || !fullName || !mobile || !email || !message) {
                res.status(400).json({ ok: false, message: 'All fields are required' });
                return;
            }
            console.log(`[Help Center] New request from ${username} (${email})`);
            // Check if SMTP is configured
            const isPlaceholder = !process.env.SMTP_USER || process.env.SMTP_USER.includes('your-email') || !process.env.SMTP_PASS;
            if (isPlaceholder) {
                console.warn('⚠️ SMTP credentials not configured. Simulation mode.');
                console.log('Ticket Data:', req.body);
                res.status(200).json({
                    ok: true,
                    message: 'Issue registered (Debug: SMTP not configured, details logged to server console)'
                });
                return;
            }
            // 1. Configure Email Transporter
            const transporter = nodemailer_1.default.createTransport({
                host: process.env.SMTP_HOST || 'smtp.gmail.com',
                port: parseInt(process.env.SMTP_PORT || '587'),
                secure: process.env.SMTP_PORT === '465',
                auth: {
                    user: process.env.SMTP_USER,
                    pass: process.env.SMTP_PASS,
                },
            });
            // 2. Email Content for Admin
            const mailOptions = {
                from: `"Help Center" <${process.env.SMTP_USER}>`,
                to: process.env.ADMIN_EMAIL || process.env.SMTP_USER,
                subject: `New Help Request from ${fullName} (${username})`,
                text: `New Help Request Received:\nUsername: ${username}\nFull Name: ${fullName}\nMobile: ${mobile}\nEmail: ${email}\n\nMessage:\n${message}`,
                html: `
                  <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #ddd; border-radius: 8px;">
                    <h2 style="color: #007bff;">New Help Request</h2>
                    <p><strong>Username:</strong> ${username}</p>
                    <p><strong>Full Name:</strong> ${fullName}</p>
                    <p><strong>Mobile:</strong> ${mobile}</p>
                    <p><strong>Email:</strong> ${email}</p>
                    <hr />
                    <p><strong>Message:</strong></p>
                    <p style="background: #f9f9f9; padding: 15px; border-left: 4px solid #007bff;">${message}</p>
                  </div>
                `,
            };
            // 3. Send Email
            await transporter.sendMail(mailOptions);
            // 4. Send Confirmation to User
            const userMailOptions = {
                from: `"Support Team" <${process.env.SMTP_USER}>`,
                to: email,
                subject: `Your Help Request has been registered`,
                text: `Hi ${fullName}, thank you for contacting us. Your ticket has been generated. Our team will review your message and get back to you shortly.`,
            };
            transporter.sendMail(userMailOptions).catch(err => console.error("Failed to send confirmation email", err));
            res.status(200).json({ ok: true, message: 'Issue registered successfully' });
        }
        catch (error) {
            console.error('Help Request Submission Error:', error);
            res.status(500).json({
                ok: false,
                message: 'Failed to register issue. Please check server SMTP configuration.',
                error: error.message
            });
        }
    }
}
exports.HelpController = HelpController;
