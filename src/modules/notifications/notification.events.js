'use strict';

const {
    safeCreateNotification,
    safeCreateAdminActorNotifications,
} = require('./notification.service');
const {
    NOTIFICATION_TYPES,
    NOTIFICATION_PRIORITIES,
} = require('./notification.model');
const { ROLES } = require('../users/user.model');

const ADMIN_SUPERVISOR_ROLES = [ROLES.ADMIN, ROLES.SUPERVISOR];
const ORDER_VIEW_PERMISSIONS = ['orders.view', 'orders.update'];
const ORDER_REFUND_PERMISSIONS = ['orders.view', 'orders.update', 'orders.refund'];
const ORDER_REFUND_WALLET_PERMISSIONS = [
    'orders.view',
    'orders.update',
    'orders.refund',
    'wallet.view',
    'wallet.adjust',
];
const WALLET_PERMISSIONS = ['wallet.view', 'wallet.adjust'];
const TOPUP_PERMISSIONS = ['topups.review'];
const PAYMENT_PERMISSIONS = ['payments.view', 'wallet.view'];

const toId = (value) => {
    if (!value) return null;
    if (typeof value === 'object' && value._id) return value._id;
    return value;
};

const toIdString = (value) => {
    const id = toId(value);
    return id ? String(id) : '';
};

const orderIdOf = (order) => toIdString(order?._id || order?.id);
const userIdOf = (orderOrUserId) => toIdString(orderOrUserId?.userId || orderOrUserId);
const orderNumberOf = (order) => order?.orderNumber || orderIdOf(order).slice(-6);
const amountLabel = (amount, currency = 'USD') => `${amount ?? ''} ${currency || 'USD'}`.trim();

const orderRoute = (order) => `/admin/orders?orderId=${orderIdOf(order)}`;
const userOrderRoute = () => '/orders';
const adminWalletRoute = (userId) => `/admin/wallet?userId=${toIdString(userId)}`;
const userWalletRoute = () => '/wallet';
const topupRoute = (depositId) => `/admin/payments?topupId=${toIdString(depositId)}`;

const adminOrderNotification = (order, eventType, payload = {}) => safeCreateAdminActorNotifications({
    roles: ADMIN_SUPERVISOR_ROLES,
    permissions: payload.permissions || ORDER_VIEW_PERMISSIONS,
    permissionMode: 'any',
    title: payload.title,
    message: payload.message,
    type: NOTIFICATION_TYPES.ORDER,
    priority: payload.priority || NOTIFICATION_PRIORITIES.NORMAL,
    route: payload.route || orderRoute(order),
    entityType: 'order',
    entityId: toId(order?._id || order?.id),
    metadata: {
        eventKey: `order:${orderIdOf(order)}:${eventType}`,
        eventType,
        orderId: orderIdOf(order),
        orderNumber: orderNumberOf(order),
        userId: userIdOf(order),
        status: order?.status || null,
        ...payload.metadata,
    },
});

const userOrderNotification = (order, eventType, payload = {}) => safeCreateNotification({
    userId: toId(order?.userId),
    title: payload.title,
    message: payload.message,
    type: NOTIFICATION_TYPES.ORDER,
    priority: payload.priority || NOTIFICATION_PRIORITIES.NORMAL,
    route: payload.route || userOrderRoute(order),
    entityType: 'order',
    entityId: toId(order?._id || order?.id),
    metadata: {
        eventKey: `user:${userIdOf(order)}:order:${orderIdOf(order)}:${eventType}`,
        eventType,
        orderId: orderIdOf(order),
        orderNumber: orderNumberOf(order),
        status: order?.status || null,
        ...payload.metadata,
    },
});

const userWalletNotification = (userId, eventType, payload = {}) => safeCreateNotification({
    userId: toId(userId),
    title: payload.title,
    message: payload.message,
    type: NOTIFICATION_TYPES.WALLET,
    priority: payload.priority || NOTIFICATION_PRIORITIES.NORMAL,
    route: payload.route || userWalletRoute(),
    entityType: payload.entityType || 'wallet',
    entityId: payload.entityId || null,
    metadata: {
        eventKey: `user:${toIdString(userId)}:wallet:${eventType}:${toIdString(payload.entityId) || payload.transactionId || ''}`,
        eventType,
        userId: toIdString(userId),
        ...payload.metadata,
    },
});

const adminWalletNotification = (userId, eventType, payload = {}) => safeCreateAdminActorNotifications({
    roles: ADMIN_SUPERVISOR_ROLES,
    permissions: WALLET_PERMISSIONS,
    permissionMode: 'any',
    title: payload.title,
    message: payload.message,
    type: NOTIFICATION_TYPES.WALLET,
    priority: payload.priority || NOTIFICATION_PRIORITIES.NORMAL,
    route: payload.route || adminWalletRoute(userId),
    entityType: payload.entityType || 'wallet',
    entityId: payload.entityId || null,
    metadata: {
        eventKey: `wallet:${toIdString(userId)}:${eventType}:${toIdString(payload.entityId) || payload.transactionId || ''}`,
        eventType,
        userId: toIdString(userId),
        ...payload.metadata,
    },
});

const adminTopupNotification = (deposit, eventType, payload = {}) => safeCreateAdminActorNotifications({
    roles: ADMIN_SUPERVISOR_ROLES,
    permissions: TOPUP_PERMISSIONS,
    permissionMode: 'any',
    title: payload.title,
    message: payload.message,
    type: NOTIFICATION_TYPES.DEPOSIT,
    priority: payload.priority || NOTIFICATION_PRIORITIES.NORMAL,
    route: payload.route || topupRoute(deposit?._id || deposit?.id),
    entityType: 'topup',
    entityId: toId(deposit?._id || deposit?.id),
    metadata: {
        eventKey: `topup:${toIdString(deposit?._id || deposit?.id)}:${eventType}`,
        eventType,
        depositId: toIdString(deposit?._id || deposit?.id),
        userId: userIdOf(deposit),
        status: deposit?.status || null,
        ...payload.metadata,
    },
});

const userDepositNotification = (deposit, eventType, payload = {}) => safeCreateNotification({
    userId: toId(deposit?.userId),
    title: payload.title,
    message: payload.message,
    type: NOTIFICATION_TYPES.DEPOSIT,
    priority: payload.priority || NOTIFICATION_PRIORITIES.NORMAL,
    route: payload.route || userWalletRoute(),
    entityType: 'topup',
    entityId: toId(deposit?._id || deposit?.id),
    metadata: {
        eventKey: `user:${userIdOf(deposit)}:topup:${toIdString(deposit?._id || deposit?.id)}:${eventType}`,
        eventType,
        depositId: toIdString(deposit?._id || deposit?.id),
        status: deposit?.status || null,
        ...payload.metadata,
    },
});

const notifyOrderCreated = (order, { manualReview = false } = {}) => {
    void adminOrderNotification(order, 'created', {
        title: 'طلب جديد',
        message: `تم إنشاء طلب جديد رقم ${orderNumberOf(order)} ويحتاج إلى المتابعة.`,
        metadata: { executionType: order?.executionType || null },
    });

    if (manualReview) {
        void adminOrderNotification(order, 'manual_review', {
            title: 'طلب يحتاج مراجعة يدوية',
            message: `الطلب رقم ${orderNumberOf(order)} يحتاج إلى تنفيذ أو مراجعة يدوية.`,
            priority: NOTIFICATION_PRIORITIES.HIGH,
            metadata: { reason: 'MANUAL_ORDER' },
        });
    }
};

const notifyOrderCompleted = (order, { source = 'system' } = {}) => {
    void adminOrderNotification(order, 'completed', {
        title: 'تم تنفيذ طلب',
        message: `تم تنفيذ الطلب رقم ${orderNumberOf(order)} بنجاح.`,
        metadata: { source },
    });

    void userOrderNotification(order, 'completed', {
        title: 'تم تنفيذ الطلب',
        message: 'تم تنفيذ طلبك بنجاح.',
        metadata: { source },
    });
};

const notifyOrderFailed = (order, { source = 'system', reason = null, notifyUser = true } = {}) => {
    void adminOrderNotification(order, 'failed', {
        title: 'فشل تنفيذ طلب',
        message: `فشل تنفيذ الطلب رقم ${orderNumberOf(order)} ويحتاج إلى مراجعة.`,
        priority: NOTIFICATION_PRIORITIES.HIGH,
        metadata: { source, reason },
    });

    if (notifyUser) {
        void userOrderNotification(order, 'failed', {
            title: 'تعذر تنفيذ الطلب',
            message: 'تعذر تنفيذ طلبك. سيتم تحديثك عند إتمام المراجعة.',
            priority: NOTIFICATION_PRIORITIES.NORMAL,
            metadata: { source },
        });
    }
};

const notifyOrderRefunded = (order, {
    refundAmount = null,
    currency = null,
    source = 'system',
    reason = null,
    providerRejected = false,
    partial = false,
} = {}) => {
    const resolvedCurrency = currency || order?.currency || 'USD';
    const refundText = refundAmount != null ? amountLabel(refundAmount, resolvedCurrency) : '';
    const eventType = partial ? 'partial_refunded' : 'refunded';

    void adminOrderNotification(order, eventType, {
        permissions: ORDER_REFUND_PERMISSIONS,
        title: partial ? 'تم رد جزء من مبلغ الطلب' : 'تم رد مبلغ طلب',
        message: partial
            ? `تم رد جزء من مبلغ الطلب رقم ${orderNumberOf(order)} إلى المستخدم.`
            : `تم رد مبلغ الطلب رقم ${orderNumberOf(order)} إلى المستخدم.`,
        priority: providerRejected ? NOTIFICATION_PRIORITIES.HIGH : NOTIFICATION_PRIORITIES.NORMAL,
        metadata: { source, reason, refundAmount, currency: resolvedCurrency, partial },
    });

    void adminWalletNotification(order?.userId, `refund:${orderIdOf(order)}`, {
        title: 'تمت إضافة رد مبلغ إلى محفظة مستخدم',
        message: `تم رد مبلغ ${refundText || 'للطلب'} إلى محفظة المستخدم.`,
        priority: providerRejected ? NOTIFICATION_PRIORITIES.HIGH : NOTIFICATION_PRIORITIES.NORMAL,
        entityType: 'order',
        entityId: toId(order?._id || order?.id),
        metadata: { orderId: orderIdOf(order), orderNumber: orderNumberOf(order), refundAmount, currency: resolvedCurrency, source, reason },
    });

    void userOrderNotification(order, eventType, {
        title: partial ? 'تم رد جزء من مبلغ الطلب' : 'تم رد مبلغ الطلب',
        message: partial
            ? 'تم تنفيذ جزء من طلبك ورد المبلغ المتبقي إلى محفظتك.'
            : 'تعذر تنفيذ طلبك وتم رد المبلغ إلى محفظتك.',
        priority: NOTIFICATION_PRIORITIES.NORMAL,
        metadata: { refundAmount, currency: resolvedCurrency, partial },
    });

    void userWalletNotification(order?.userId, `refund:${orderIdOf(order)}`, {
        title: 'تم رد مبلغ إلى محفظتك',
        message: refundText
            ? `تم رد مبلغ ${refundText} إلى محفظتك.`
            : 'تم رد المبلغ إلى محفظتك.',
        entityType: 'order',
        entityId: toId(order?._id || order?.id),
        metadata: { orderId: orderIdOf(order), orderNumber: orderNumberOf(order), refundAmount, currency: resolvedCurrency, source, reason },
    });

    if (providerRejected) {
        void safeCreateAdminActorNotifications({
            roles: ADMIN_SUPERVISOR_ROLES,
            permissions: ORDER_REFUND_WALLET_PERMISSIONS,
            permissionMode: 'any',
            title: 'تحذير: رفض المورد طلبا وتم رد المبلغ',
            message: 'تحذير: تم رفض الطلب من المورد وتم رد المبلغ للمستخدم. راجع العملية المرفوضة لهذا المستخدم.',
            type: NOTIFICATION_TYPES.ORDER,
            priority: NOTIFICATION_PRIORITIES.HIGH,
            route: orderRoute(order),
            entityType: 'order',
            entityId: toId(order?._id || order?.id),
            metadata: {
                eventKey: `order:${orderIdOf(order)}:provider_rejected_refunded`,
                eventType: 'provider_rejected_refunded',
                orderId: orderIdOf(order),
                orderNumber: orderNumberOf(order),
                userId: userIdOf(order),
                refundAmount,
                currency: resolvedCurrency,
                source,
                reason,
            },
        });
    }
};

const notifyOrderManualReview = (order, { reason = 'MANUAL_REVIEW' } = {}) => {
    void adminOrderNotification(order, 'manual_review', {
        title: 'طلب انتقل إلى المراجعة اليدوية',
        message: `الطلب رقم ${orderNumberOf(order)} انتقل إلى المراجعة اليدوية ويحتاج إلى تدخل الإدارة.`,
        priority: NOTIFICATION_PRIORITIES.HIGH,
        metadata: { reason },
    });
};

const notifyManualWalletAdjustment = ({
    userId,
    operation,
    amount,
    currency = 'USD',
    transactionId,
    balanceBefore,
    balanceAfter,
    actorRole,
}) => {
    const normalizedOperation = String(operation || '').toUpperCase();
    const eventType = `manual_${normalizedOperation.toLowerCase()}`;
    const label = amountLabel(amount, currency);
    const isCredit = normalizedOperation === 'ADD' || normalizedOperation === 'CREDIT';
    const isSet = normalizedOperation === 'SET';

    void adminWalletNotification(userId, `${eventType}:${transactionId || ''}`, {
        title: isSet ? 'تم ضبط رصيد محفظة' : (isCredit ? 'تمت إضافة رصيد لمحفظة' : 'تم خصم رصيد من محفظة'),
        message: isSet
            ? `تم ضبط رصيد محفظة مستخدم إلى ${label}.`
            : `تم ${isCredit ? 'إضافة' : 'خصم'} مبلغ ${label} ${isCredit ? 'إلى' : 'من'} محفظة مستخدم.`,
        transactionId,
        metadata: { operation: normalizedOperation, amount, currency, balanceBefore, balanceAfter, actorRole },
    });

    void userWalletNotification(userId, `${eventType}:${transactionId || ''}`, {
        title: isSet ? 'تم تحديث رصيد محفظتك' : (isCredit ? 'تمت إضافة رصيد إلى محفظتك' : 'تم خصم رصيد من محفظتك'),
        message: isSet
            ? 'تم تحديث رصيد محفظتك من قبل الإدارة.'
            : `تم ${isCredit ? 'إضافة' : 'خصم'} مبلغ ${label} ${isCredit ? 'إلى' : 'من'} محفظتك.`,
        transactionId,
        metadata: { operation: normalizedOperation, amount, currency, balanceBefore, balanceAfter },
    });
};

const notifyDepositApproved = (deposit, { walletCreditAmount, walletCurrency = 'USD' } = {}) => {
    const label = amountLabel(walletCreditAmount, walletCurrency);

    void userDepositNotification(deposit, 'approved', {
        title: 'تم قبول طلب الشحن',
        message: label
            ? `تم قبول طلب الشحن وإضافة ${label} إلى محفظتك.`
            : 'تم قبول طلب الشحن وإضافة الرصيد إلى محفظتك.',
        metadata: { walletCreditAmount, walletCurrency },
    });

    void userWalletNotification(deposit?.userId, `topup:${toIdString(deposit?._id || deposit?.id)}`, {
        title: 'تم شحن محفظتك',
        message: label ? `تم إضافة ${label} إلى محفظتك.` : 'تم إضافة الرصيد إلى محفظتك.',
        entityType: 'topup',
        entityId: toId(deposit?._id || deposit?.id),
        metadata: { depositId: toIdString(deposit?._id || deposit?.id), walletCreditAmount, walletCurrency },
    });

    void adminTopupNotification(deposit, 'approved', {
        title: 'تم قبول طلب شحن',
        message: `تم قبول طلب الشحن رقم ${toIdString(deposit?._id || deposit?.id).slice(-6)} وإضافة الرصيد للمستخدم.`,
        metadata: { walletCreditAmount, walletCurrency },
    });
};

const notifyDepositRejected = (deposit) => {
    void userDepositNotification(deposit, 'rejected', {
        title: 'تم رفض طلب الشحن',
        message: 'تم رفض طلب الشحن. يمكنك مراجعة التفاصيل أو إنشاء طلب جديد عند الحاجة.',
    });

    void adminTopupNotification(deposit, 'rejected', {
        title: 'تم رفض طلب شحن',
        message: `تم رفض طلب الشحن رقم ${toIdString(deposit?._id || deposit?.id).slice(-6)}.`,
    });
};

const notifyPaymentSucceeded = (payment, { transactionId } = {}) => {
    const label = amountLabel(payment?.amount, payment?.currency || 'USD');
    const paymentId = toIdString(payment?._id || payment?.id);

    void userWalletNotification(payment?.userId, `payment:${paymentId}:succeeded`, {
        title: 'Wallet top-up completed',
        message: label
            ? `Your wallet was credited with ${label}.`
            : 'Your wallet top-up was completed.',
        entityType: 'payment',
        entityId: toId(payment?._id || payment?.id),
        transactionId,
        metadata: {
            paymentId,
            transactionId: toIdString(transactionId),
            amount: payment?.amount,
            currency: payment?.currency,
            gateway: payment?.gateway,
        },
    });

    void safeCreateAdminActorNotifications({
        roles: ADMIN_SUPERVISOR_ROLES,
        permissions: PAYMENT_PERMISSIONS,
        permissionMode: 'any',
        title: 'Wallet top-up succeeded',
        message: `A wallet top-up${label ? ` for ${label}` : ''} was completed.`,
        type: NOTIFICATION_TYPES.WALLET,
        priority: NOTIFICATION_PRIORITIES.NORMAL,
        route: `/admin/payments?paymentId=${paymentId}`,
        entityType: 'payment',
        entityId: toId(payment?._id || payment?.id),
        metadata: {
            eventKey: `payment:${paymentId}:succeeded`,
            eventType: 'payment_succeeded',
            paymentId,
            userId: userIdOf(payment),
            amount: payment?.amount,
            currency: payment?.currency,
            gateway: payment?.gateway,
        },
    });
};

module.exports = {
    notifyOrderCreated,
    notifyOrderCompleted,
    notifyOrderFailed,
    notifyOrderRefunded,
    notifyOrderManualReview,
    notifyManualWalletAdjustment,
    notifyDepositApproved,
    notifyDepositRejected,
    notifyPaymentSucceeded,
};
