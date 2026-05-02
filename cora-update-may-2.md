# Cora Autonomous Agent: Engineering Log (May 2, 2026)

## 1. Auto-Exit Logic (The "Brain")
- **Autonomous Monitoring**: Implemented `AutoExitService` which periodically monitors all open trades in the background.
- **Dynamic TP/SL Enforcement**: The service automatically fetches real-time prices via Zerion API and compares them against user-defined Take Profit and Stop Loss percentages.
- **Automated Selling**: When a target is hit, Cora triggers an automated SELL transaction (Token -> SOL) using the secure Agent Token, ensuring 24/7 profit protection without manual intervention.

## 2. PnL Dashboard (The "Analytics")
- **Real-Time Stats**: Added a dedicated PnL Dashboard to the Telegram Bot.
- **Performance Metrics**: Users can now view their Win Rate, Total PnL %, and total trading volume.
- **Trade History**: Displays the last 5 trades with status (Open/Closed), SOL amounts, and precise PnL results.

## 3. Trade Management Infrastructure
- **TradeService**: Centralized trade history and statistics calculation logic.
- **Enhanced TradeExecutor**: Added `executeSell` capabilities and robust exit recording, including slippage handling and zero-balance protection.

## Technical Context
- **New Files**:
    - `src/cora/services/auto-exit-service.js`: Background monitoring loop.
    - `src/cora/services/trade-service.js`: History and stats logic.
- **Modified Files**:
    - `src/cora/services/trade-executor.js`: Added sell logic.
    - `src/cora/bot/bot-manager.js`: Added PnL UI and handlers.
    - `src/cora/index.js`: Service orchestration.

---
**Status**: Auto-Exit & PnL Dashboard are LIVE.
**Next Priority**: Trailing Stop Loss and Advanced Tactics (Force Candles).
