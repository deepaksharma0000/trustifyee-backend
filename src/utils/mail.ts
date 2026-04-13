import nodemailer from 'nodemailer';

export const sendWelcomeEmail = async (userData: {
    email: string;
    full_name: string;
    user_name: string;
    password: string;
    licence: string;
}) => {
    try {
        console.log(`[Email] Attempting to send welcome email to: ${userData.email} (${userData.licence})`);
        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST || 'smtp.hostinger.com',
            port: parseInt(process.env.SMTP_PORT || '587'),
            secure: process.env.SMTP_PORT === '465',
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
            },
            tls: {
                rejectUnauthorized: false
            }
        });

        const softwareDetails = userData.licence === 'Demo' ? 'Demo Account' : 'Live Trading Account';

        const mailOptions = {
            from: `"Trustifye Algo Solution" <${process.env.SMTP_USER}>`,
            to: userData.email,
            subject: `Welcome to Trustifye Algo Solution - Your Account is Ready`,
            html: `
                <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: auto; border: 1px solid #eee; padding: 20px;">
                    <p>Dear ${userData.full_name},</p>
                    <p>We appreciate your selection of <strong>Trustifye Algo Solution</strong> for the Algo Platform (API Bridge Platform). This message is to notify you that your platform access has been configured. Below are your login details:</p>
                    
                    <p style="background: #f4f4f4; padding: 10px; border-radius: 5px;">
                        <strong>Software Details:</strong> ${softwareDetails}
                    </p>

                    <h3 style="color: #2c3e50; border-bottom: 2px solid #3498db; padding-bottom: 5px;">Login Details:</h3>
                    <p>
                        <strong>User Email:</strong> ${userData.email}<br>
                        <strong>Login Password:</strong> ${userData.password}
                    </p>
                    <p><em>Note: Please change your login password as per your preference.</em></p>
                    <p><strong>Login URL:</strong> <a href="https://trustifye.cloud/auth/jwt/login">https://trustifye.cloud/auth/jwt/login</a></p>

                    <hr>
                    <h3 style="color: #2c3e50;">INSTRUCTIONS ON USING THE SOFTWARE AND TRAINING:</h3>
                    <ul>
                        <li>Log in precisely at 09:00 AM.</li>
                        <li>The ON/OFF buttons are accessible only on the client panel for your convenience.</li>
                        <li>Exit and close positions upon achieving a small profit.</li>
                        <li>Avoid engaging in manual trading.</li>
                        <li>Keep your login ID and password confidential.</li>
                    </ul>

                    <hr>
                    <h3 style="color: #e74c3c;">IMPORTANT NOTICE:</h3>
                    <p>Before commencing the use of the software, please review all terms carefully. For further details, refer to our Terms & Conditions, Disclaimer, and Privacy Policy available on the website.</p>

                    <hr>
                    <p><strong>DISCLAIMER (Hindi):</strong></p>
                    <p style="font-size: 13px;">सभी प्रतिभूतियां एल्गो ट्रेडिंग सिस्टम बाजार जोखिमों के अधीन हैं और इस बात का कोई आश्वासन नहीं दिया जा सकता है कि उपयोगकर्ता के उद्देश्यों को आज के प्रदर्शन के आधार पर प्राप्त किया जाएगा। यह परिणाम केवल आज के लिए मान्य है।</p>

                    <p><strong>DISCLAIMER (English):</strong></p>
                    <p style="font-size: 13px;">THIS RESULT IS VALID FOR TODAY ONLY; WE DO NOT DIRECTLY OR INDIRECTLY MAKE ANY REFERENCE TO THE PAST OR EXPECTED FUTURE RETURN/PERFORMANCE OF THE ALGORITHM.</p>

                    <hr>
                    <p><strong>General Disclaimer:</strong></p>
                    <p style="font-size: 13px;">We do not offer advice, nor do we function as investment advisors. All fees paid for subscriptions to Trustifye Algo Solution are non-refundable. Please refrain from sharing your ID and password with any representative; we cannot be held responsible for any losses or gains. Avoid discussing financial details through chat applications like WhatsApp. Kindly refer to the website for all official information.</p>

                    <hr>
                    <p><strong>Important Note (Hindi):</strong></p>
                    <p style="font-size: 13px;">किसी व्यक्ति विशेष कार्यकारिणी सदस्य द्वारा बोली गई बातें लॉगिन करने से पहले हमारी वेबसाइट से पढ़ और समझ लें अन्यथा कंपनी द्वारा किसी भी वार्तालाप, व्हाट्सएप चैट या एसएमएस की जिम्मेदारी नहीं ली जाएगी (कंपनी द्वारा जनहित में जारी)।</p>

                    <p><strong>Important Note (English):</strong></p>
                    <p style="font-size: 13px;">Read and understand the statements made by any executive member from our website before logging in; otherwise, the company will not take responsibility for any WhatsApp chats or SMS (issued in public interest by the company).</p>

                    <hr>
                    <p>Regards,<br>
                    <strong>Trustifye Algo Solution Team</strong><br>
                    🌐 <a href="https://trustifye.cloud">https://trustifye.cloud</a></p>
                </div>
            `
        };

        // Send Welcome Email to User
        await transporter.sendMail(mailOptions);

        // Send Notification Email to Admin
        const adminMailOptions = {
            from: `"System Monitor" <${process.env.SMTP_USER}>`,
            to: process.env.ADMIN_EMAIL || process.env.SMTP_USER,
            subject: `Success: Welcome Email Sent to ${userData.full_name}`,
            text: `The welcome email for ${userData.full_name} (${userData.email}) with ${userData.licence} licence has been successfully delivered.`,
        };

        await transporter.sendMail(adminMailOptions);

        console.log(`✅ [Email] Welcome email and Admin notification sent successfully for ${userData.email}`);
        return { success: true };
    } catch (error) {
        console.error('Error sending welcome email:', error);
        return { success: false, error };
    }
};
