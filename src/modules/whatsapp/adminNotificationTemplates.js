'use strict';

const text = (value) => String(value ?? '').trim()
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(api[_-]?key|authorization|token|password|secret)\b\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, 500) || '-';
const money = (amount, currency) => amount === undefined || amount === null ? '-' : `${amount} ${text(currency)}`;
const line = (label, value) => `${label}: ${text(value)}`;
const stamp = (payload) => line('الوقت', payload.timestamp || new Date().toISOString());
const customer = (payload) => payload.customerName || payload.userName || payload.customerEmail || payload.email || payload.userId;
const renderAdminMessage = (eventType, payload = {}) => {
    const commonOrder = [line('رقم الطلب', payload.orderNumber || payload.orderId), line('المنتج', payload.productName || payload.product), line('الكمية', payload.quantity), line('الهدف / UID', payload.target || payload.targetUid || payload.accountId), line('المورد', payload.provider || payload.providerCode), line('الحالة المحلية', payload.localStatus || payload.status), stamp(payload)];
    const messages = {
        NEW_ORDER: ['🛒 طلب جديد', ...commonOrder.slice(0, 5), line('العميل', customer(payload)), line('الإجمالي', money(payload.amount, payload.currency)), line('نوع التنفيذ', payload.executionType), line('الحالة المحلية', payload.localStatus || payload.status), stamp(payload)],
        PAYMENT_SUCCESS: ['✅ دفع ناجح', line('العميل', customer(payload)), line('المبلغ', money(payload.amount, payload.currency)), line('طريقة الدفع', payload.gateway || payload.paymentMethod), line('مرجع الدفع', payload.paymentId || payload.referenceId || payload.transactionId), line('مرجع الطلب/الشحن', payload.relatedReference), stamp(payload)],
        DEPOSIT_PENDING: ['💰 إيداع قيد المراجعة', line('رقم الإيداع', payload.depositId || payload.requestId), line('العميل', customer(payload)), line('المبلغ', money(payload.amount, payload.currency)), line('الطريقة', payload.paymentMethod), line('مرجع العميل', payload.reference), line('الحالة', payload.status), stamp(payload)],
        PROVIDER_FAILURE: ['🚨 فشل مورد / تنفيذ طلب', ...commonOrder.slice(0, 5), line('العميل', customer(payload)), line('المبلغ', money(payload.amount, payload.currency)), line('معرف المورد', payload.providerOrderId), line('حالة المورد', payload.providerStatus), line('رمز الخطأ', payload.errorCode), line('الخطأ', payload.reason || payload.errorMessage), line('حالة الاسترداد', payload.refundStatus), stamp(payload)],
        MANUAL_REVIEW: ['⚠️ طلب يحتاج مراجعة يدوية', ...commonOrder.slice(0, 5), line('العميل', customer(payload)), line('المبلغ', money(payload.amount, payload.currency)), line('معرف المورد', payload.providerOrderId), line('حالة المورد', payload.providerStatus), line('السبب', payload.reason || payload.errorMessage), line('تم رد المبلغ', payload.refunded === true ? 'نعم' : payload.refunded === false ? 'لا' : '-'), stamp(payload)],
        AUTOMATIC_PAYMENT_ERROR: ['⚠️ خطأ الدفع/الإشعار التلقائي', line('مرجع الدفع/الطلب', payload.paymentId || payload.orderNumber), line('العميل', customer(payload)), line('المبلغ', money(payload.amount, payload.currency)), line('المرحلة', payload.stage || payload.source), line('رمز الخطأ', payload.errorCode), line('الخطأ', payload.errorMessage), line('الحالة', payload.status), stamp(payload)],
        DAY_CLOSED: ['📊 تم تقفيل اليوم', line('التاريخ', payload.date), line('المنطقة الزمنية', payload.timezone), line('عدد التحذيرات', payload.warningsCount), line('عدد المعاملات', payload.transactionCount), line('الإدارة', payload.adminName), stamp(payload)],
        LARGE_WALLET_ADJUSTMENT: ['💳 تعديل محفظة كبير', line('المستخدم', customer(payload)), line('الاتجاه', payload.operation), line('المبلغ', money(payload.amount, payload.currency)), line('الرصيد السابق', payload.balanceBefore), line('الرصيد الجديد', payload.balanceAfter), line('السبب', payload.reason), line('المنفذ', payload.actorName || payload.actorRole), line('المرجع', payload.transactionId), stamp(payload)],
        PROVIDER_BALANCE_WARNING: ['⚠️ تحذير رصيد مورد', line('المورد', payload.provider), line('الرصيد الحالي', payload.balance), line('حد التحذير', payload.threshold), payload.currency ? line('العملة/الوحدة', payload.currency) : null, stamp(payload), '⚠️ الرصيد أصبح أقل من أو يساوي الحد المحدد.', 'يرجى شحن رصيد المورد لتجنب توقف أو فشل الطلبات.'],
        SUB_AGENT_REQUEST: ['👤 طلب وكيل فرعي جديد', line('رقم الطلب', payload.requestId), line('مقدم الطلب', customer(payload)), line('المجموعة/الدور', payload.group || payload.role || payload.requestedGroup), line('الحساب/التواصل', payload.accountIdentifier || payload.email), line('الحالة', payload.status), stamp(payload)],
    };
    return (messages[eventType] || ['Winnie', line('الحدث', eventType), stamp(payload)]).join('\n').slice(0, 1800);
};

module.exports = { renderAdminMessage };
