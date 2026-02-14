import moment from "moment-timezone";

// List of holidays (YYYY-MM-DD)
// This can be fetched from DB or external API in future
export const NSE_HOLIDAYS_2024 = [
    "2024-01-26", // Republic Day
    "2024-03-08", // Mahashivratri
    "2024-03-25", // Holi
    "2024-03-29", // Good Friday
    "2024-04-11", // Id-Ul-Fitr
    "2024-04-17", // Ram Navami
    "2024-05-01", // Maharashtra Day
    "2024-06-17", // Bakri Id
    "2024-07-17", // Moharram
    "2024-08-15", // Independence Day
    "2024-10-02", // Gandhi Jayanti
    "2024-11-01", // Diwali
    "2024-11-15", // Guru Nanak Jayanti
    "2024-12-25", // Christmas
];

export const NSE_HOLIDAYS_2025 = [
    "2025-01-26",
    // Add more as needed
    "2025-12-25"
];

const HOLIDAYS = [...NSE_HOLIDAYS_2024, ...NSE_HOLIDAYS_2025];

export class MarketStatusService {
    /**
     * Check if the market is currently open.
     * Logic:
     * 1. Check if Weekend (Sat/Sun)
     * 2. Check if Holiday
     * 3. Check Time (09:15 - 15:30 IST)
     */
    static isMarketOpen(): boolean {
        const now = moment().tz("Asia/Kolkata");

        // 1. Weekend Check
        const day = now.day(); // 0=Sun, 1=Mon, ..., 6=Sat
        if (day === 0 || day === 6) {
            return false;
        }

        // 2. Holiday Check
        const todayStr = now.format("YYYY-MM-DD");
        if (HOLIDAYS.includes(todayStr)) {
            return false;
        }

        // 3. Time Check
        const currentTime = now.clone();
        const marketOpen = now.clone().hour(9).minute(15).second(0);
        const marketClose = now.clone().hour(15).minute(30).second(0);

        return currentTime.isBetween(marketOpen, marketClose);
    }

    static getMarketStatus() {
        const start = moment().tz("Asia/Kolkata");
        const isOpen = this.isMarketOpen();
        let message = isOpen ? "Market is Open" : "Market is Closed";

        // Add detail if closed
        const day = start.day();
        if (day === 0 || day === 6) message = "Market Closed (Weekend)";
        if (HOLIDAYS.includes(start.format("YYYY-MM-DD"))) message = "Market Closed (Holiday)";

        const marketOpen = start.clone().hour(9).minute(15).second(0);
        const marketClose = start.clone().hour(15).minute(30).second(0);

        if (!isOpen && !message.includes("Weekend") && !message.includes("Holiday")) {
            if (start.isBefore(marketOpen)) message = "Market Pre-Open (Opens at 09:15 AM)";
            if (start.isAfter(marketClose)) message = "Market Closed (Closed at 03:30 PM)";
        }

        return {
            isOpen,
            message,
            serverTime: start.format("YYYY-MM-DD HH:mm:ss"),
            timezone: "Asia/Kolkata"
        };
    }

    static validateOrderRequest() {
        if (!this.isMarketOpen()) {
            const status = this.getMarketStatus();
            throw new Error(`Order Rejected: ${status.message}`);
        }
    }
}
