import moment from 'moment';

export const validateEmail = (email: string) => {
    const re = /\S+@\S+\.\S+/;
    return re.test(email);
};

export const validatePhoneNumber = (phone: string) => {
    // Basic validation, enhance as needed
    const re = /^[0-9]{10,15}$/;
    return re.test(phone);
}

export const generateAccessCode = async () => {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = moment().add(10, 'minutes').toDate();
    return { otp, expiry };
}

export const TimeDiffrance = (expiresAt: Date | string, currentTime: string, unit: 'm' | 's' = 'm') => {
    const end = moment(expiresAt);
    const now = moment(currentTime);
    return end.diff(now, unit === 'm' ? 'minutes' : 'seconds'); // if negative, expired
}
