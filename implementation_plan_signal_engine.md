# Implementation Plan - System Refactor & Signal Engine

This plan outlines the steps to implement the final scope as defined by the user.

## Phase 1: Model & Schema Updates
1.  **Modify `User` Model (`src/models/User.ts`):**
    -   Add `broker_verified: boolean` (default: `false`).
    -   Add `is_online: boolean` (default: `false`).
    -   Add `broker_config: { apiKey: string, clientCode: string }` (optional, encrypted).
2.  **Create `Signal` Model (`src/models/Signal.ts`):**
    -   Fields: `adminTradeId`, `symbol`, `type` (BUY/SELL), `strike`, `expiry`, `price`, `status` (ACTIVE/EXPIRED), `createdAt`.
3.  **Update `Position` Model (`src/models/Position.model.ts`):**
    -   Add `signalId` to link user trades to signals.

## Phase 2: Broker Ownership & Admin Approval (Task 1 & 5)
1.  **Backend - User Registration/Update:**
    -   Update `controllers/UserController.ts` to allow users to save `apiKey` and `clientCode` (encrypted).
    -   Setting these fields should NOT set `broker_verified` to `true`.
2.  **Backend - Admin Approval:**
    -   Create endpoint `POST /api/admin/verify-broker/:userId` to let admin set `broker_verified = true`.
3.  **Backend - Status Tracking:**
    -   Update `AuthController.ts` to set `is_online = true` on login and `false` on logout.
    -   Middleware/Cron to clean up `is_online` for expired sessions.
4.  **Frontend - User Broker Connect:**
    -   Update `pages/profile/broker-connect.tsx` with a form to submit `API Key` and `Client Code`.
    -   Show "Awaiting Admin Approval" status.
5.  **Frontend - Admin Dashboard:**
    -   Update User management table to show Online Status, Broker Connected, Licence, and Trading Ready.

## Phase 3: Admin Signal Engine (Task 2)
1.  **Detect Admin Trades:**
    -   Create a service `SignalService.ts`.
    -   If a trade is placed via Admin account (or explicitly marked as Admin Run), create a `Signal` entry.
2.  **Fan-out Logic:**
    -   When a `Signal` is created, identify users with matching strategies/groups.
    -   Store "Target Users" for each signal.

## Phase 4: User Confirmation & Logic Refactor (Task 3 & 4)
1.  **AlgoEngine Refactor (`src/services/algoEngine.ts`):**
    -   Modify `placeTradesForRun`:
        -   If `user.licence === "Live"`, do NOT call `placeOrderForClient`.
        -   Instead, emit a signal/notification and create a `PendingTrade` entry.
        -   If `user.licence === "Demo"`, continue auto-execution.
2.  **Frontend - User Signal Dashboard:**
    -   New component on User Home/Dashboard to show "Active Trade Signals".
    -   Inputs: Lot size (editable, default 1).
    -   Action: "Execute Trade" button.
3.  **Backend - Signal Execution:**
    -   `POST /api/signals/execute`:
        -   Check if user is `Live`, `broker_verified`, and `trading_status` is `enabled`.
        -   Place real order via `OrderService` using user's keys.

## Phase 5: Testing & Verification
1.  Verify Admin trade creates signals.
2.  Verify Live user cannot auto-trade.
3.  Verify Signal execution with custom lots.
4.  Verify Admin status indicators.
