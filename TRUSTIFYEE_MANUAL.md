# 📘 Trustifyee Algo Trading System - Official Manual

Welcome to the **Trustifyee** User Manual. This document provides clear instructions for both **Administrators** and **Users** based on the latest signal-based execution architecture.

---

## 🏗️ PART 1: ADMIN PANEL (Management Guide)

### 1. User Management (Client Creation)
- **Go to:** Dashboard -> Client Management.
- **Add New Client:** Fill in the username, email, and mobile number.
- **Licence Type:**
    - **Demo:** Users get 2 days of free paper trading. Algo executes automatically.
    - **Live:** Users must connect their broker. Algo generates **Signals** instead of auto-trading.
- **Strategies:** Select specific strategies (Alpha, Delta, Gamma, etc.) to assign to the user.

### 2. Status Indicators & Monitoring
Observe the user table for these columns:
- **Online/Offline:** Green dot means the user is currently logged into the dashboard.
- **Broker Connected:** Blue checkmark means the user's broker credentials are verified.
- **Trading Ready:** Shows **'Ready'** only if Licence is Live, Broker is Verified, and Trading Status is Enabled.

### 3. Broker Verification (Mandatory Step)
- When a user submits their **API Key** and **Client Code**, their status will show "Unverified" (Error icon).
- Open **Quick Edit** for the user.
- Verify the details provided by the user.
- Toggle **"Broker Verified"** to **ON**.
- Save changes. The user can now trade.

### 4. Admin Signal Flow
- When an Admin initiates a trade or an Algo strategy triggers a signal:
- The system checks for all "Live" users linked to that strategy.
- It "fans out" the trade details as a **Signal** to their dashboards.

---

## 📈 PART 2: USER DASHBOARD (Trading Guide)

### 1. Getting Started (Login)
- Use your **Username**, **Email**, or **Broker Client ID** to login.
- Default password is set by admin (usually `user@123`).

### 2. Connecting Your Broker (Live Users Only)
- Go to **Profile -> Broker Connect**.
- Follow the steps to get your **API Key** and **Client Code** from the Angel SmartAPI portal.
- Paste these into the form and click **"Submit for Approval"**.
- your status will be **"Awaiting Admin Approval"**. Once admin verifies, you are ready to trade.

### 3. Trading Mechanisms

#### **A. Demo Mode (Automation)**
- If your licence is **Demo**, you don't need to do anything.
- The Algo Engine will automatically place paper trades in your account based on signals.
- You can monitor these in your PnL and Positions section.

#### **B. Live Mode (Signal Confirmation Layer)**
- **Auto-execution is OFF** for security and control.
- When an Algo trigger happens, a **Green Signal Box** will appear on your dashboard.
- **Steps to Trade:**
    1. View the incoming signal (e.g., BUY NIFTY 22000 CE).
    2. **Edit Lots:** The default is 1 lot. Change this if you wish to trade more.
    3. **Execute:** Click the **"Execute"** button.
    4. Only after clicking, the order is sent to your broker (AngelOne/Upstox/etc.).

### 4. Monitoring Positions
- Live PnL is visible on the main dashboard.
- Use the **Manual Actions** table to manually square off or Buy CE/PE if needed outside of signals.

---

## 🔒 Security Best Practices
- **Encryption:** All API keys and Client codes are encrypted before storage in our database.
- **Session Management:** Logs out automatically after inactivity to protect your trading account.
- **Mandatory Approval:** No Live trade can occur unless the Admin has manually verified the user's broker status.

---

**Trustifyee Support Team**  
*Empowering your trading with smart signals.*
