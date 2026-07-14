'use strict';

const mongoose = require('mongoose');
const { User, ROLES } = require('../users/user.model');
const Group = require('../groups/group.model');
const { WalletTransaction, TRANSACTION_DIRECTIONS, TRANSACTION_SOURCE_TYPES, LEDGER_TRANSACTION_TYPES } = require('../wallet/walletTransaction.model');
const { Payment } = require('../payments/payment.model');
const { PAYMENT_STATUSES } = require('../payments/payment.constants');
const { DepositRequest, DEPOSIT_STATUS } = require('../deposits/deposit.model');
const { Order, ORDER_STATUS } = require('../orders/order.model');
const { Product } = require('../products/product.model');
const { Provider } = require('../providers/provider.model');
const { Currency } = require('../currency/currency.model');
const { getProviderAdapter } = require('../providers/adapters/adapter.factory');
const { FinancialDailyClose } = require('./financialDailyClose.model');
const { ConflictError, ValidationError } = require('../../shared/errors/AppError');
const { Decimal, toDecimal, toFiat } = require('../../shared/utils/decimalPrecision');

const REPORT_VERSION = 1;
const DEFAULT_TIMEZONE = 'Africa/Cairo';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const USD = 'USD';

const asId = (value) => value?._id?.toString?.() || value?.toString?.() || '';
const asDate = (value) => (value ? new Date(value) : null);
const iso = (value) => (value ? new Date(value).toISOString() : '');
const money = (value) => toFiat(value);

const normalizeCurrency = (value) => String(value || USD).trim().toUpperCase();

const getGatewayCurrencyConversion = (payment = {}) => (
    payment.metadata?.gatewayCurrencyConversion
    || payment.metadata?.gatewayCharge
    || payment.metadata?.conversion
    || {}
);

const getGatewayAmount = (payment = {}) => {
    const conversion = getGatewayCurrencyConversion(payment);
    return Number(
        payment.gatewayAmount
        ?? conversion.gatewayAmount
        ?? conversion.amount
        ?? payment.totalAmount
        ?? payment.amount
        ?? 0
    );
};

const getGatewayCurrency = (payment = {}) => {
    const conversion = getGatewayCurrencyConversion(payment);
    return normalizeCurrency(payment.gatewayCurrency || conversion.gatewayCurrency || conversion.currency || payment.currency);
};

const compactText = (value) => {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
};

const isWithinRange = (value, start, end) => {
    if (!value) return false;
    const time = new Date(value).getTime();
    return time >= start.getTime() && time <= end.getTime();
};

const getPaymentBusinessTime = (payment) => payment.succeededAt || payment.creditedAt || payment.createdAt;

const assertReportInput = (date, timezone) => {
    if (!DATE_RE.test(String(date || ''))) {
        throw new ValidationError('date must be in YYYY-MM-DD format.');
    }

    try {
        new Intl.DateTimeFormat('en-US', { timeZone: timezone || DEFAULT_TIMEZONE }).format(new Date());
    } catch {
        throw new ValidationError('timezone must be a valid IANA timezone.');
    }
};

const getTimezoneOffsetMs = (timeZone, utcDate) => {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    }).formatToParts(utcDate).reduce((acc, part) => {
        if (part.type !== 'literal') acc[part.type] = part.value;
        return acc;
    }, {});

    const hour = parts.hour === '24' ? '00' : parts.hour;
    const localAsUtc = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(hour),
        Number(parts.minute),
        Number(parts.second)
    );

    return localAsUtc - utcDate.getTime();
};

const zonedTimeToUtc = (date, timeZone, hour, minute, second, millisecond) => {
    const [year, month, day] = date.split('-').map(Number);
    let utcMillis = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
    for (let i = 0; i < 3; i += 1) {
        const offset = getTimezoneOffsetMs(timeZone, new Date(utcMillis));
        utcMillis = Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - offset;
    }
    return new Date(utcMillis);
};

const getDayBounds = (date, timezone = DEFAULT_TIMEZONE) => {
    assertReportInput(date, timezone);
    return {
        dayStartUtc: zonedTimeToUtc(date, timezone, 0, 0, 0, 0),
        dayEndUtc: zonedTimeToUtc(date, timezone, 23, 59, 59, 999),
    };
};

const buildCurrencyContext = async () => {
    const currencies = await Currency.find().lean();
    const rates = new Map(currencies.map((currency) => [
        normalizeCurrency(currency.code),
        Number(currency.platformRate),
    ]));
    if (!rates.has(USD)) rates.set(USD, 1);

    const warnings = [];
    const toUsd = (amount, currency) => {
        const code = normalizeCurrency(currency);
        const rate = rates.get(code);
        if (!rate || rate <= 0) {
            warnings.push(`Missing platform exchange rate for ${code}. USD equivalent left blank.`);
            return null;
        }
        return Number(toDecimal(amount).dividedBy(rate).toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber());
    };

    return { rates, toUsd, warnings };
};

const addCurrencyTotal = (totals, currency, amount) => {
    const code = normalizeCurrency(currency);
    const current = totals[code] || '0';
    totals[code] = toDecimal(current).plus(toDecimal(amount)).toString();
};

const withUsdEquivalent = (totals, currencyContext) => Object.entries(totals).map(([currency, amount]) => ({
    currency,
    amount: Number(toDecimal(amount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber()),
    usdEquivalentApprox: currencyContext.toUsd(amount, currency),
}));

const groupWalletBalances = (snapshots) => {
    const totals = {};
    for (const snapshot of snapshots) {
        addCurrencyTotal(totals, snapshot.currency, snapshot.balance);
    }
    return totals;
};

const getUserLabel = (user) => ({
    id: asId(user),
    name: user?.name || user?.username || '',
    email: user?.email || '',
    phone: user?.phone || '',
});

const buildWalletBalanceSnapshots = async (currencyContext, source = 'current_at_export_time') => {
    const users = await User.find({ role: ROLES.CUSTOMER, deletedAt: null })
        .populate('groupId', 'name')
        .select('name username email phone status groupId currency walletBalance')
        .lean();
    const userIds = users.map((user) => user._id);
    const lastTransactions = await WalletTransaction.aggregate([
        { $match: { userId: { $in: userIds } } },
        { $sort: { createdAt: -1 } },
        { $group: { _id: '$userId', createdAt: { $first: '$createdAt' } } },
    ]);
    const lastTxMap = new Map(lastTransactions.map((tx) => [asId(tx._id), tx.createdAt]));

    return users.map((user) => {
        const currency = normalizeCurrency(user.currency);
        const balance = Number(user.walletBalance || 0);
        return {
            userId: user._id,
            name: user.name || user.username || '',
            email: user.email || '',
            phone: user.phone || '',
            status: user.status || '',
            groupName: user.groupId?.name || '',
            currency,
            balance,
            usdEquivalent: currencyContext.toUsd(balance, currency),
            balanceSource: source,
            lastWalletTransactionAt: lastTxMap.get(asId(user._id)) || null,
        };
    });
};

const extractProviderBalance = (raw) => {
    if (raw === null || raw === undefined) return { amount: null, currency: USD };
    if (typeof raw === 'number' || typeof raw === 'string') {
        const parsed = Number(String(raw).replace(/[^\d.-]/g, ''));
        return { amount: Number.isFinite(parsed) ? parsed : null, currency: USD };
    }

    const balanceValue = raw.balance ?? raw.Balance ?? raw.amount ?? raw.Amount ?? raw.credit ?? raw.Credit ?? raw.funds ?? raw.Funds;
    const currency = normalizeCurrency(raw.currency || raw.Currency || raw.code || raw.balanceCurrency || USD);
    if (balanceValue !== undefined && balanceValue !== null && balanceValue !== raw) {
        const nested = extractProviderBalance(balanceValue);
        return { amount: nested.amount, currency: normalizeCurrency(nested.currency || currency) };
    }

    return { amount: null, currency };
};

const providerSupportsBalance = (provider) => {
    const features = Array.isArray(provider.supportedFeatures) ? provider.supportedFeatures : [];
    return features.some((feature) => ['balance', 'getbalance', 'fetchbalance', 'getmyinfo', 'account'].includes(String(feature).toLowerCase()));
};

const buildProviderBalanceSnapshots = async ({ manualBalances = [], currencyContext, adminId, fetchApiBalances = false }) => {
    const providers = await Provider.find({ deletedAt: null }).lean();
    const manualMap = new Map(
        (manualBalances || [])
            .filter((item) => item?.providerId)
            .map((item) => [String(item.providerId), item])
    );
    const snapshots = [];
    const warnings = [];

    for (const provider of providers) {
        const providerId = asId(provider._id);
        const manual = manualMap.get(providerId);
        if (manual && manual.balance !== undefined && manual.balance !== null && manual.balance !== '') {
            const currency = normalizeCurrency(manual.currency);
            const balance = Number(manual.balance);
            snapshots.push({
                providerId: provider._id,
                providerName: provider.name || provider.slug || providerId,
                source: 'manual',
                balance: Number.isFinite(balance) ? balance : null,
                currency,
                usdEquivalent: Number.isFinite(balance) ? currencyContext.toUsd(balance, currency) : null,
                fetchedAt: new Date(),
                enteredBy: adminId,
                apiStatus: null,
                note: manual.note || 'Manual balance snapshot',
            });
            continue;
        }

        if (fetchApiBalances && providerSupportsBalance(provider)) {
            try {
                const adapter = getProviderAdapter(provider, { strict: true });
                const raw = await adapter.getBalance();
                const parsed = extractProviderBalance(raw);
                snapshots.push({
                    providerId: provider._id,
                    providerName: provider.name || provider.slug || providerId,
                    source: 'api',
                    balance: parsed.amount,
                    currency: parsed.currency,
                    usdEquivalent: parsed.amount === null ? null : currencyContext.toUsd(parsed.amount, parsed.currency),
                    fetchedAt: new Date(),
                    enteredBy: null,
                    apiStatus: 'success',
                    note: parsed.amount === null ? 'Provider returned balance response without a numeric amount.' : '',
                });
                continue;
            } catch (err) {
                warnings.push(`Provider balance fetch failed for ${provider.name || providerId}: ${err.message}`);
                snapshots.push({
                    providerId: provider._id,
                    providerName: provider.name || provider.slug || providerId,
                    source: 'error',
                    balance: null,
                    currency: null,
                    usdEquivalent: null,
                    fetchedAt: new Date(),
                    enteredBy: null,
                    apiStatus: 'error',
                    note: err.message,
                });
                continue;
            }
        }

        warnings.push(`Provider balance unavailable for ${provider.name || providerId}; manual snapshot required.`);
        snapshots.push({
            providerId: provider._id,
            providerName: provider.name || provider.slug || providerId,
            source: 'unavailable',
            balance: null,
            currency: null,
            usdEquivalent: null,
            fetchedAt: null,
            enteredBy: null,
            apiStatus: providerSupportsBalance(provider) ? 'not_fetched' : 'unsupported',
            note: 'Not available / Manual snapshot required',
        });
    }

    return { snapshots, warnings };
};

const loadDailyTransactions = async (dayStartUtc, dayEndUtc) => WalletTransaction.find({
    createdAt: { $gte: dayStartUtc, $lte: dayEndUtc },
})
    .populate('userId', 'name username email phone currency')
    .populate('actorId', 'name email role')
    .sort({ createdAt: 1 })
    .lean();

const loadDailyPayments = async (dayStartUtc, dayEndUtc) => Payment.find({
    $or: [
        { createdAt: { $gte: dayStartUtc, $lte: dayEndUtc } },
        { succeededAt: { $gte: dayStartUtc, $lte: dayEndUtc } },
        { creditedAt: { $gte: dayStartUtc, $lte: dayEndUtc } },
        { failedAt: { $gte: dayStartUtc, $lte: dayEndUtc } },
    ],
})
    .populate('userId', 'name username email phone currency')
    .sort({ createdAt: 1 })
    .lean();

const loadDailyDeposits = async (dayStartUtc, dayEndUtc) => DepositRequest.find({
    status: DEPOSIT_STATUS.APPROVED,
    reviewedAt: { $gte: dayStartUtc, $lte: dayEndUtc },
})
    .populate('userId', 'name username email phone currency')
    .populate('reviewedBy', 'name email role')
    .sort({ reviewedAt: 1 })
    .lean();

const loadDailyOrders = async (dayStartUtc, dayEndUtc, walletMovements) => {
    const orderDebitMovements = walletMovements.filter((tx) =>
        tx.semanticType === LEDGER_TRANSACTION_TYPES.ORDER_DEBIT
        || tx.sourceType === TRANSACTION_SOURCE_TYPES.ORDER
        || tx.reference
    );
    const ids = [...new Set(orderDebitMovements.map((tx) => asId(tx.sourceId || tx.reference)).filter(Boolean))];
    const objectIds = ids.filter(mongoose.Types.ObjectId.isValid).map((id) => new mongoose.Types.ObjectId(id));

    const query = objectIds.length
        ? { _id: { $in: objectIds } }
        : { createdAt: { $gte: dayStartUtc, $lte: dayEndUtc }, walletDeducted: { $gt: 0 } };

    const fallbackQuery = {
        createdAt: { $gte: dayStartUtc, $lte: dayEndUtc },
        walletDeducted: { $gt: 0 },
        status: { $ne: ORDER_STATUS.PENDING },
    };

    const [linked, fallback] = await Promise.all([
        Order.find(query)
            .populate('userId', 'name username email phone currency')
            .populate('productId', 'name category provider providerProduct')
            .sort({ createdAt: 1 })
            .lean(),
        Order.find(fallbackQuery)
            .populate('userId', 'name username email phone currency')
            .populate('productId', 'name category provider providerProduct')
            .sort({ createdAt: 1 })
            .lean(),
    ]);

    const map = new Map();
    for (const order of [...linked, ...fallback]) map.set(asId(order._id), order);
    const providerIds = [...new Set([...map.values()].map((order) => asId(order.productId?.provider)).filter(Boolean))];
    const providers = providerIds.length
        ? await Provider.find({ _id: { $in: providerIds } }).select('name slug').lean()
        : [];
    const providerMap = new Map(providers.map((provider) => [asId(provider._id), provider]));

    return [...map.values()].map((order) => ({
        ...order,
        provider: providerMap.get(asId(order.productId?.provider)) || null,
        walletTransaction: orderDebitMovements.find((tx) => asId(tx.sourceId || tx.reference) === asId(order._id)) || null,
    }));
};

const buildSummary = ({ walletSnapshots, walletMovements, payments, deposits, orders, currencyContext, dayStartUtc, dayEndUtc }) => {
    const walletCredits = {};
    const walletDebits = {};
    const gatewayReceived = {};
    const gatewayWalletCredits = {};
    const manualDeposits = {};
    const adminCredits = {};
    const adminDebits = {};
    const orderPaid = {};
    const providerCosts = {};
    let successfulPaymentCount = 0;
    let pendingFailedPaymentCount = 0;
    let refundsCount = 0;

    for (const tx of walletMovements) {
        if (tx.direction === TRANSACTION_DIRECTIONS.CREDIT) addCurrencyTotal(walletCredits, tx.currency, tx.amount);
        if (tx.direction === TRANSACTION_DIRECTIONS.DEBIT) addCurrencyTotal(walletDebits, tx.currency, tx.amount);
        if ([LEDGER_TRANSACTION_TYPES.REFUND, LEDGER_TRANSACTION_TYPES.ORDER_REFUND].includes(tx.semanticType)) refundsCount += 1;
        if (tx.semanticType === LEDGER_TRANSACTION_TYPES.ADMIN_ADJUSTMENT || tx.sourceType === TRANSACTION_SOURCE_TYPES.ADMIN_ADJUSTMENT) {
            if (tx.direction === TRANSACTION_DIRECTIONS.CREDIT) addCurrencyTotal(adminCredits, tx.currency, tx.amount);
            if (tx.direction === TRANSACTION_DIRECTIONS.DEBIT) addCurrencyTotal(adminDebits, tx.currency, tx.amount);
        }
    }

    for (const payment of payments) {
        if (
            payment.status === PAYMENT_STATUSES.SUCCEEDED
            && isWithinRange(getPaymentBusinessTime(payment), dayStartUtc, dayEndUtc)
        ) {
            successfulPaymentCount += 1;
            addCurrencyTotal(gatewayReceived, getGatewayCurrency(payment), getGatewayAmount(payment));
            addCurrencyTotal(gatewayWalletCredits, payment.currency, payment.amount);
        } else {
            pendingFailedPaymentCount += 1;
        }
    }

    for (const deposit of deposits) {
        addCurrencyTotal(manualDeposits, deposit.currency, deposit.requestedAmount);
    }

    for (const order of orders) {
        const paidAmount = order.walletTransaction?.amount ?? order.chargedAmount ?? order.walletDeducted ?? order.totalPrice ?? 0;
        const paidCurrency = normalizeCurrency(order.walletTransaction?.currency || order.currency || order.userId?.currency);
        addCurrencyTotal(orderPaid, paidCurrency, paidAmount);

        const cost = toDecimal(order.basePriceSnapshot || 0).times(order.quantity || 1);
        if (cost.greaterThan(0)) addCurrencyTotal(providerCosts, USD, cost);
    }

    const orderPaidUsd = withUsdEquivalent(orderPaid, currencyContext).reduce((sum, item) => sum.plus(item.usdEquivalentApprox || 0), toDecimal(0));
    const providerCostUsd = withUsdEquivalent(providerCosts, currencyContext).reduce((sum, item) => sum.plus(item.usdEquivalentApprox || 0), toDecimal(0));

    return {
        walletBalancesByCurrency: withUsdEquivalent(groupWalletBalances(walletSnapshots), currencyContext),
        walletCreditsByCurrency: withUsdEquivalent(walletCredits, currencyContext),
        walletDebitsByCurrency: withUsdEquivalent(walletDebits, currencyContext),
        gatewayReceivedByCurrency: withUsdEquivalent(gatewayReceived, currencyContext),
        gatewayWalletCreditsByCurrency: withUsdEquivalent(gatewayWalletCredits, currencyContext),
        manualDepositsByCurrency: withUsdEquivalent(manualDeposits, currencyContext),
        adminManualCreditsByCurrency: withUsdEquivalent(adminCredits, currencyContext),
        adminManualDebitsByCurrency: withUsdEquivalent(adminDebits, currencyContext),
        orderPaidByCurrency: withUsdEquivalent(orderPaid, currencyContext),
        providerCostByCurrency: withUsdEquivalent(providerCosts, currencyContext),
        grossProfitUsdApprox: Number(orderPaidUsd.minus(providerCostUsd).toDecimalPlaces(6).toNumber()),
        successfulPaymentCount,
        approvedDepositCount: deposits.length,
        adminAdjustmentCount: walletMovements.filter((tx) => tx.semanticType === LEDGER_TRANSACTION_TYPES.ADMIN_ADJUSTMENT || tx.sourceType === TRANSACTION_SOURCE_TYPES.ADMIN_ADJUSTMENT).length,
        orderCount: orders.length,
        refundCount: refundsCount,
        pendingFailedPaymentCount,
    };
};

const buildReconciliationWarnings = ({ closed, providerWarnings, currencyWarnings, walletMovements, payments, orders, dayStartUtc, dayEndUtc }) => {
    const warnings = [...new Set([...providerWarnings, ...currencyWarnings])];
    if (!closed) {
        warnings.push('Wallet balances are current at export time, not historical closing balances.');
    }

    const successfulUncredited = payments.filter((payment) =>
        payment.status === PAYMENT_STATUSES.SUCCEEDED
        && isWithinRange(getPaymentBusinessTime(payment), dayStartUtc, dayEndUtc)
        && !payment.walletTransactionId
        && !payment.creditedAt
    );
    if (successfulUncredited.length) warnings.push(`${successfulUncredited.length} successful payments have no wallet credit marker.`);

    const paymentSourceIds = new Set(payments.map((payment) => asId(payment._id)));
    const orphanPaymentCredits = walletMovements.filter((tx) =>
        tx.sourceType === TRANSACTION_SOURCE_TYPES.PAYMENT
        && !paymentSourceIds.has(asId(tx.sourceId))
    );
    if (orphanPaymentCredits.length) warnings.push(`${orphanPaymentCredits.length} wallet payment credits have no loaded payment record in this report window.`);

    const missingCosts = orders.filter((order) => !toDecimal(order.basePriceSnapshot || 0).greaterThan(0));
    if (missingCosts.length) warnings.push('Some provider costs are missing, profit may be inaccurate.');

    warnings.push('Wallet ledger totals are internal accounting. Gateway totals are external payment reconciliation. Do not add both as separate income.');
    return warnings;
};

const getCloseStatus = async ({ date, timezone = DEFAULT_TIMEZONE }) => {
    assertReportInput(date, timezone);
    const close = await FinancialDailyClose.findOne({ date, timezone })
        .populate('closedBy', 'name email role')
        .lean();

    return {
        closed: Boolean(close),
        close: close ? {
            id: asId(close._id),
            date: close.date,
            timezone: close.timezone,
            closedAt: close.closedAt,
            closedBy: close.closedBy ? getUserLabel(close.closedBy) : null,
            reportVersion: close.reportVersion,
            warnings: close.warnings || [],
        } : null,
    };
};

const buildReportData = async ({
    date,
    timezone = DEFAULT_TIMEZONE,
    admin,
    closedDownload = false,
    manualProviderBalances = [],
    fetchProviderBalances = false,
} = {}) => {
    assertReportInput(date, timezone);
    const { dayStartUtc, dayEndUtc } = getDayBounds(date, timezone);
    const currencyContext = await buildCurrencyContext();
    const existingClose = await FinancialDailyClose.findOne({ date, timezone }).lean();
    const walletMovements = await loadDailyTransactions(dayStartUtc, dayEndUtc);
    const payments = await loadDailyPayments(dayStartUtc, dayEndUtc);
    const deposits = await loadDailyDeposits(dayStartUtc, dayEndUtc);
    const orders = await loadDailyOrders(dayStartUtc, dayEndUtc, walletMovements);

    let walletSnapshots;
    let providerSnapshots;
    let providerWarnings = [];
    const useClosed = Boolean(existingClose);

    if (useClosed) {
        walletSnapshots = (existingClose.walletBalanceSnapshots || []).map((snapshot) => ({
            ...snapshot,
            balanceSource: 'closing_snapshot',
        }));
        providerSnapshots = existingClose.providerBalanceSnapshots || [];
        providerWarnings = [];
    } else {
        walletSnapshots = await buildWalletBalanceSnapshots(currencyContext, 'current_at_export_time');
        const providerResult = await buildProviderBalanceSnapshots({
            manualBalances: manualProviderBalances,
            currencyContext,
            adminId: admin?._id,
            fetchApiBalances: fetchProviderBalances,
        });
        providerSnapshots = providerResult.snapshots;
        providerWarnings = providerResult.warnings;
    }

    const dynamicSummary = buildSummary({
        walletSnapshots,
        walletMovements,
        payments,
        deposits,
        orders,
        currencyContext,
        dayStartUtc,
        dayEndUtc,
    });
    const summary = useClosed && existingClose.summary ? existingClose.summary : dynamicSummary;
    const warnings = buildReconciliationWarnings({
        closed: useClosed,
        providerWarnings,
        currencyWarnings: currencyContext.warnings,
        walletMovements,
        payments,
        orders,
        dayStartUtc,
        dayEndUtc,
    });

    return {
        reportVersion: REPORT_VERSION,
        date,
        timezone,
        currencyRates: Object.fromEntries(currencyContext.rates),
        dayStartUtc,
        dayEndUtc,
        generatedAt: new Date(),
        generatedBy: admin ? getUserLabel(admin) : null,
        closed: useClosed,
        close: useClosed ? existingClose : null,
        summary,
        walletBalanceSnapshots: walletSnapshots,
        providerBalanceSnapshots: providerSnapshots,
        walletMovements,
        payments,
        deposits,
        orders,
        warnings,
    };
};

const closeDay = async ({ date, timezone = DEFAULT_TIMEZONE, admin, providerManualBalances = [] } = {}) => {
    assertReportInput(date, timezone);
    const { dayStartUtc, dayEndUtc } = getDayBounds(date, timezone);
    const exists = await FinancialDailyClose.findOne({ date, timezone }).lean();
    if (exists) {
        throw new ConflictError('Financial day is already closed for this date and timezone.');
    }

    const report = await buildReportData({
        date,
        timezone,
        admin,
        manualProviderBalances: providerManualBalances,
        fetchProviderBalances: true,
    });

    const close = await FinancialDailyClose.create({
        date,
        timezone,
        dayStartUtc,
        dayEndUtc,
        closedAt: new Date(),
        closedBy: admin._id,
        reportVersion: REPORT_VERSION,
        summary: report.summary,
        walletBalanceSnapshots: report.walletBalanceSnapshots.map((snapshot) => ({
            ...snapshot,
            balanceSource: undefined,
        })),
        providerBalanceSnapshots: report.providerBalanceSnapshots,
        warnings: report.warnings,
        notes: [],
    });

    return close.populate('closedBy', 'name email role');
};

const txRows = (walletMovements) => walletMovements.map((tx) => {
    const user = getUserLabel(tx.userId);
    const actor = tx.actorId ? getUserLabel(tx.actorId) : null;
    return [
        iso(tx.createdAt),
        user.id,
        user.name,
        user.email,
        tx.direction || tx.type,
        tx.semanticType || tx.type,
        Number(tx.amount || 0),
        normalizeCurrency(tx.currency),
        Number(tx.balanceBefore ?? 0),
        Number(tx.balanceAfter ?? 0),
        tx.sourceType || '',
        asId(tx.sourceId || tx.reference),
        tx.metadata?.gateway || tx.metadata?.provider || '',
        actor?.name || actor?.email || tx.actorRole || '',
        tx.idempotencyKey || '',
        tx.description || tx.reason || tx.note || compactText(tx.metadata),
    ];
});

const incomingRows = ({ payments, deposits, walletMovements, dayStartUtc, dayEndUtc }) => {
    const rows = [];
    const txMap = new Map(walletMovements.map((tx) => [asId(tx._id), tx]));
    for (const payment of payments.filter((item) =>
        item.status === PAYMENT_STATUSES.SUCCEEDED
        && isWithinRange(getPaymentBusinessTime(item), dayStartUtc, dayEndUtc)
    )) {
        const user = getUserLabel(payment.userId);
        const tx = txMap.get(asId(payment.walletTransactionId));
        rows.push([
            iso(payment.creditedAt || payment.succeededAt || payment.createdAt),
            user.id,
            user.name,
            user.email,
            'gateway_payment',
            payment.gateway || payment.method || '',
            Number(payment.amount || tx?.amount || 0),
            normalizeCurrency(payment.currency || tx?.currency),
            Number(payment.feeAmount || 0),
            Number(payment.totalAmount || payment.amount || 0),
            getGatewayAmount(payment),
            getGatewayCurrency(payment),
            payment.gatewayReference || payment.gatewayPaymentId || '',
            asId(payment._id),
            payment.status,
            '',
            compactText(payment.metadata),
        ]);
    }
    for (const deposit of deposits) {
        const user = getUserLabel(deposit.userId);
        rows.push([
            iso(deposit.reviewedAt || deposit.updatedAt),
            user.id,
            user.name,
            user.email,
            'manual_deposit',
            deposit.paymentMethodId || '',
            Number(deposit.requestedAmount || 0),
            normalizeCurrency(deposit.currency),
            0,
            Number(deposit.requestedAmount || 0),
            '',
            '',
            '',
            asId(deposit._id),
            deposit.status,
            deposit.reviewedBy?.name || deposit.reviewedBy?.email || '',
            deposit.adminNotes || deposit.notes || '',
        ]);
    }
    for (const tx of walletMovements.filter((item) =>
        item.direction === TRANSACTION_DIRECTIONS.CREDIT
        && (item.semanticType === LEDGER_TRANSACTION_TYPES.ADMIN_ADJUSTMENT || item.sourceType === TRANSACTION_SOURCE_TYPES.ADMIN_ADJUSTMENT)
    )) {
        const user = getUserLabel(tx.userId);
        rows.push([
            iso(tx.createdAt),
            user.id,
            user.name,
            user.email,
            'admin_adjustment_credit',
            '',
            Number(tx.amount || 0),
            normalizeCurrency(tx.currency),
            0,
            Number(tx.amount || 0),
            '',
            '',
            '',
            asId(tx._id),
            tx.status,
            tx.actorId?.name || tx.actorRole || '',
            tx.description || tx.reason || tx.note || compactText(tx.metadata),
        ]);
    }
    return rows.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
};

const orderRows = (orders, currencyContext) => orders.map((order) => {
    const user = getUserLabel(order.userId);
    const tx = order.walletTransaction;
    const paidAmount = Number(tx?.amount ?? order.chargedAmount ?? order.walletDeducted ?? 0);
    const paidCurrency = normalizeCurrency(tx?.currency || order.currency || order.userId?.currency);
    const providerCost = Number(toDecimal(order.basePriceSnapshot || 0).times(order.quantity || 1).toDecimalPlaces(6).toNumber());
    const providerCostCurrency = providerCost > 0 ? USD : '';
    const paidUsd = currencyContext.toUsd(paidAmount, paidCurrency);
    const providerCostUsd = providerCost > 0 ? currencyContext.toUsd(providerCost, providerCostCurrency) : null;
    return [
        asId(order._id),
        iso(tx?.createdAt || order.createdAt),
        user.id,
        user.name,
        user.email,
        asId(order.productId),
        order.productId?.name || '',
        order.productId?.category || '',
        order.provider?.name || order.providerCode || '',
        asId(order.productId?.providerProduct),
        Number(order.quantity || 0),
        paidAmount,
        paidCurrency,
        paidUsd,
        providerCost || '',
        providerCostCurrency,
        providerCostUsd,
        paidUsd !== null && providerCostUsd !== null ? Number(toDecimal(paidUsd).minus(providerCostUsd).toDecimalPlaces(6).toNumber()) : '',
        order.status || '',
        order.providerOrderId || '',
        asId(tx?._id),
        order.rejectionReason || (order.refunded ? 'Refunded' : ''),
    ];
});

const providerSummaryRows = (orders, currencyContext) => {
    const groups = new Map();
    for (const order of orders) {
        const providerId = asId(order.provider?._id || order.productId?.provider) || order.providerCode || 'manual';
        if (!groups.has(providerId)) {
            groups.set(providerId, {
                providerId,
                providerName: order.provider?.name || order.providerCode || 'Manual / unavailable',
                orders: [],
                customerPaid: {},
                providerCosts: {},
                lastTime: null,
            });
        }
        const group = groups.get(providerId);
        group.orders.push(order);
        const tx = order.walletTransaction;
        addCurrencyTotal(group.customerPaid, tx?.currency || order.currency, tx?.amount ?? order.chargedAmount ?? order.walletDeducted ?? 0);
        const cost = toDecimal(order.basePriceSnapshot || 0).times(order.quantity || 1);
        if (cost.greaterThan(0)) addCurrencyTotal(group.providerCosts, USD, cost);
        const time = asDate(tx?.createdAt || order.createdAt);
        if (time && (!group.lastTime || time > group.lastTime)) group.lastTime = time;
    }

    return [...groups.values()].map((group) => {
        const customer = withUsdEquivalent(group.customerPaid, currencyContext);
        const costs = withUsdEquivalent(group.providerCosts, currencyContext);
        const customerUsd = customer.reduce((sum, item) => sum.plus(item.usdEquivalentApprox || 0), toDecimal(0));
        const costUsd = costs.reduce((sum, item) => sum.plus(item.usdEquivalentApprox || 0), toDecimal(0));
        const missingCost = group.orders.some((order) => !toDecimal(order.basePriceSnapshot || 0).greaterThan(0));
        return [
            group.providerId,
            group.providerName,
            group.orders.length,
            group.orders.filter((order) => order.status === ORDER_STATUS.COMPLETED).length,
            group.orders.filter((order) => [ORDER_STATUS.FAILED, ORDER_STATUS.CANCELED].includes(order.status)).length,
            group.orders.filter((order) => [ORDER_STATUS.PENDING, ORDER_STATUS.PROCESSING, ORDER_STATUS.MANUAL_REVIEW].includes(order.status)).length,
            compactText(customer),
            Number(customerUsd.toDecimalPlaces(6).toNumber()),
            compactText(costs),
            Number(costUsd.toDecimalPlaces(6).toNumber()),
            Number(customerUsd.minus(costUsd).toDecimalPlaces(6).toNumber()),
            iso(group.lastTime),
            missingCost ? 'Some provider costs are missing, profit may be inaccurate.' : '',
        ];
    });
};

const summaryRows = (report) => {
    const close = report.close || {};
    const rows = [
        { cells: ['Report Metadata'], bold: true },
        ['Report date', report.date],
        ['Timezone', report.timezone],
        ['Day start UTC', iso(report.dayStartUtc)],
        ['Day end UTC', iso(report.dayEndUtc)],
        ['Generated at', iso(report.generatedAt)],
        ['Generated by admin', report.generatedBy?.name || report.generatedBy?.email || ''],
        ['Is closed?', report.closed ? 'Yes' : 'No'],
        ['Closed at', iso(close.closedAt)],
        ['Closed by', close.closedBy?.name || close.closedBy?.email || ''],
        ['Report version', report.reportVersion],
        [],
        { cells: ['Financial Summary'], bold: true },
    ];

    const items = [
        ['Total user wallet balances grouped by currency', report.summary.walletBalancesByCurrency],
        ['Total wallet credits for the day grouped by currency', report.summary.walletCreditsByCurrency],
        ['Total wallet debits for the day grouped by currency', report.summary.walletDebitsByCurrency],
        ['Total successful gateway payments grouped by gateway currency', report.summary.gatewayReceivedByCurrency],
        ['Total wallet credit from gateway payments grouped by wallet currency', report.summary.gatewayWalletCreditsByCurrency],
        ['Total approved manual deposits grouped by currency', report.summary.manualDepositsByCurrency],
        ['Total admin manual wallet credits grouped by currency', report.summary.adminManualCreditsByCurrency],
        ['Total admin manual wallet debits grouped by currency', report.summary.adminManualDebitsByCurrency],
        ['Total order paid amounts grouped by customer currency', report.summary.orderPaidByCurrency],
        ['Total provider cost grouped by provider/cost currency', report.summary.providerCostByCurrency],
        ['Approximate gross profit USD equivalent', report.summary.grossProfitUsdApprox],
        ['Count of successful payments', report.summary.successfulPaymentCount],
        ['Count of approved deposits', report.summary.approvedDepositCount],
        ['Count of admin adjustments', report.summary.adminAdjustmentCount],
        ['Count of orders', report.summary.orderCount],
        ['Count of refunds if supported', report.summary.refundCount],
        ['Count of failed/pending payments', report.summary.pendingFailedPaymentCount],
    ];

    rows.push(...items.map(([label, value]) => [label, typeof value === 'object' ? compactText(value) : value]));
    return rows;
};

const buildWorkbookSheets = (report) => {
    const workbookCurrencyContext = {
        toUsd: (amount, currency) => {
            const rate = report.currencyRates?.[normalizeCurrency(currency)];
            if (!rate || rate <= 0) return null;
            return Number(toDecimal(amount).dividedBy(rate).toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toNumber());
        },
    };
    const balanceRows = report.walletBalanceSnapshots.map((snapshot) => [
        asId(snapshot.userId),
        snapshot.name,
        snapshot.email,
        snapshot.phone || '',
        snapshot.status,
        snapshot.groupName,
        snapshot.currency,
        Number(snapshot.balance || 0),
        snapshot.usdEquivalent ?? '',
        snapshot.balanceSource || (report.closed ? 'closing_snapshot' : 'current_at_export_time'),
        iso(snapshot.lastWalletTransactionAt),
    ]);

    return [
        { name: 'Summary', freezeRow: 14, rows: summaryRows(report) },
        {
            name: 'Wallet Balances',
            freezeRow: 2,
            rows: [
                report.closed ? ['Balance source: closing_snapshot'] : ['These balances are current at export time and may not represent historical end-of-day balances.'],
                { cells: ['User ID', 'User name', 'Email', 'Phone', 'Status', 'Group', 'Currency', 'Wallet balance', 'USD equivalent approx', 'Balance source', 'Last wallet transaction time'], bold: true },
                ...balanceRows,
            ],
        },
        {
            name: 'Wallet Movements',
            freezeRow: 1,
            rows: [
                { cells: ['Time', 'User ID', 'User name', 'Email', 'Direction', 'Semantic type', 'Amount', 'Currency', 'Balance before', 'Balance after', 'Source type', 'Source ID', 'Gateway/provider', 'Actor/admin', 'Idempotency key', 'Description/metadata summary'], bold: true },
                ...txRows(report.walletMovements),
            ],
        },
        {
            name: 'Incoming Funds',
            freezeRow: 1,
            rows: [
                { cells: ['Time credited/approved/completed', 'User ID', 'User name', 'Email', 'Source category', 'Gateway/provider/payment method', 'Wallet credit amount', 'Wallet currency', 'Fee amount', 'Total paid amount in wallet currency', 'Gateway amount', 'Gateway currency', 'Gateway reference', 'Payment ID / deposit ID / transaction ID', 'Status', 'Admin actor', 'Notes'], bold: true },
                ...incomingRows(report),
            ],
        },
        {
            name: 'Orders',
            freezeRow: 1,
            rows: [
                { cells: ['Order ID', 'Time', 'User ID', 'User name', 'Email', 'Product ID', 'Product name', 'Category', 'Provider/supplier', 'External provider product ID', 'Quantity', 'Customer paid amount', 'Customer currency', 'Customer paid USD equivalent approx', 'Provider cost amount', 'Provider cost currency', 'Provider cost USD equivalent approx', 'Estimated gross profit USD equivalent approx', 'Order status', 'Provider order ID', 'Wallet transaction ID', 'Notes/failure reason'], bold: true },
                ...orderRows(report.orders, workbookCurrencyContext),
            ],
        },
        {
            name: 'Provider Daily Summary',
            freezeRow: 1,
            rows: [
                { cells: ['Provider ID', 'Provider name', 'Orders count', 'Successful orders count', 'Failed orders count', 'Pending orders count', 'Total customer paid by currency', 'Total customer paid USD equivalent approx', 'Total provider cost by currency', 'Total provider cost USD equivalent approx', 'Estimated gross profit USD equivalent approx', 'Last provider sync/order time', 'Notes'], bold: true },
                ...providerSummaryRows(report.orders, workbookCurrencyContext),
            ],
        },
        {
            name: 'Provider Balance Snapshots',
            freezeRow: 1,
            rows: [
                { cells: ['Provider ID', 'Provider name', 'Balance source', 'Balance', 'Currency', 'USD equivalent approx', 'Fetched/entered at', 'Fetched/entered by', 'API status', 'Notes'], bold: true },
                ...report.providerBalanceSnapshots.map((snapshot) => [
                    asId(snapshot.providerId),
                    snapshot.providerName,
                    snapshot.source,
                    snapshot.balance ?? '',
                    snapshot.currency || '',
                    snapshot.usdEquivalent ?? '',
                    iso(snapshot.fetchedAt),
                    asId(snapshot.enteredBy),
                    snapshot.apiStatus || '',
                    snapshot.note || '',
                ]),
            ],
        },
        {
            name: 'Reconciliation Notes',
            freezeRow: 1,
            rows: [
                { cells: ['Type', 'Note'], bold: true },
                ...report.warnings.map((warning) => ['warning', warning]),
            ],
        },
    ];
};

module.exports = {
    REPORT_VERSION,
    DEFAULT_TIMEZONE,
    buildReportData,
    buildWorkbookSheets,
    closeDay,
    getCloseStatus,
    getDayBounds,
};
