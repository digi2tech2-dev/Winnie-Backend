'use strict';

const valueOrDash = (value) => {
    const text = String(value ?? '').trim();
    return text || '-';
};

const money = (amount, currency = '') => [amount, currency].filter((part) => part !== undefined && part !== null && String(part).trim()).join(' ');

const line = (label, value) => `${label}: ${valueOrDash(value)}`;

const renderTemplate = (eventType, payload = {}) => {
    const orderId = payload.orderNumber || payload.orderId || payload.relatedEntityId;
    const paymentId = payload.paymentId || payload.relatedEntityId;
    const amount = money(payload.amount ?? payload.walletCreditAmount ?? payload.requestedAmount, payload.currency ?? payload.walletCurrency);
    const gatewayAmount = money(payload.gatewayAmount, payload.gatewayCurrency);
    const product = payload.productName || payload.product || payload.itemName;

    const templates = {
        wallet_topup_completed: {
            title: 'تم شحن المحفظة',
            message: [
                'تم شحن محفظتك بنجاح ✅',
                line('المبلغ', amount),
                payload.gateway ? line('طريقة الدفع', payload.gateway) : null,
                payload.walletBalance != null ? line('رصيدك الحالي', money(payload.walletBalance, payload.currency)) : null,
                'Winnie',
            ],
        },
        payment_failed_or_pending: {
            title: 'حالة الدفع',
            message: [
                'لم تكتمل عملية الدفع بعد.',
                amount ? line('المبلغ', amount) : null,
                payload.status ? line('الحالة', payload.status) : null,
                'Winnie',
            ],
        },
        manual_deposit_approved: {
            title: 'تم قبول الإيداع',
            message: [
                'تم قبول طلب الإيداع وشحن محفظتك ✅',
                line('المبلغ', amount),
                'Winnie',
            ],
        },
        manual_deposit_rejected: {
            title: 'تم رفض الإيداع',
            message: [
                'تم رفض طلب الإيداع.',
                payload.reason ? line('السبب', payload.reason) : null,
                'Winnie',
            ],
        },
        order_created: {
            title: 'تم إنشاء الطلب',
            message: [
                'تم إنشاء طلبك بنجاح ✅',
                line('رقم الطلب', orderId),
                product ? line('المنتج', product) : null,
                payload.quantity ? line('الكمية', payload.quantity) : null,
                'Winnie',
            ],
        },
        order_completed: {
            title: 'تم تنفيذ الطلب',
            message: [
                'تم تنفيذ طلبك بنجاح ✅',
                line('رقم الطلب', orderId),
                'Winnie',
            ],
        },
        order_failed: {
            title: 'تعذر تنفيذ الطلب',
            message: [
                'تعذر تنفيذ طلبك.',
                line('رقم الطلب', orderId),
                'سيتم مراجعة الحالة أو رد المبلغ حسب سياسة المنصة.',
                'Winnie',
            ],
        },
        identity_verification_required: {
            title: 'توثيق الهوية مطلوب',
            message: [
                'حسابك يحتاج إلى توثيق الهوية لإتمام بعض العمليات.',
                'يرجى التواصل مع الدعم.',
                'Winnie',
            ],
        },
        security_alert: {
            title: 'تنبيه أمان',
            message: [
                payload.message || 'تم تنفيذ إجراء مهم على حسابك.',
                'إذا لم تكن أنت، يرجى التواصل مع الدعم فوراً.',
                'Winnie',
            ],
        },
        successful_payment: {
            title: 'دفع ناجح جديد',
            message: [
                'دفع ناجح جديد ✅',
                line('العميل', payload.customerName || payload.userName || payload.email),
                line('المبلغ المشحون', amount),
                payload.gateway ? line('بوابة الدفع', payload.gateway) : null,
                gatewayAmount ? line('المبلغ على البوابة', gatewayAmount) : null,
                paymentId ? line('Payment ID', paymentId) : null,
                'Winnie',
            ],
        },
        manual_deposit_pending: {
            title: 'طلب إيداع جديد',
            message: [
                'طلب إيداع جديد يحتاج مراجعة',
                line('العميل', payload.customerName || payload.userName || payload.email),
                line('المبلغ', amount),
                payload.paymentMethod ? line('طريقة التحويل', payload.paymentMethod) : null,
                'Winnie',
            ],
        },
        provider_order_failed: {
            title: 'فشل تنفيذ طلب عند المورد',
            message: [
                'فشل تنفيذ طلب عند المورد ⚠️',
                line('الطلب', orderId),
                payload.provider ? line('المورد', payload.provider) : null,
                payload.reason ? line('السبب', payload.reason) : null,
                'Winnie',
            ],
        },
        payment_webhook_error: {
            title: 'خطأ في Webhook الدفع',
            message: [
                'خطأ في Webhook الدفع ⚠️',
                payload.gateway ? line('البوابة', payload.gateway) : null,
                line('الخطأ', payload.error || payload.errorMessage),
                'Winnie',
            ],
        },
        financial_day_closed: {
            title: 'تم تقفيل اليوم المالي',
            message: [
                'تم تقفيل اليوم المالي',
                line('التاريخ', payload.date),
                payload.adminName ? line('الأدمن', payload.adminName) : null,
                'Winnie',
            ],
        },
        large_wallet_adjustment: {
            title: 'تعديل كبير على محفظة',
            message: [
                'تعديل يدوي كبير على محفظة مستخدم',
                payload.adminName ? line('الأدمن', payload.adminName) : null,
                line('العميل', payload.customerName || payload.userName || payload.userId),
                line('المبلغ', amount),
                'Winnie',
            ],
        },
        provider_balance_warning: {
            title: 'تحذير رصيد مورد',
            message: [
                'تحذير رصيد مورد',
                line('المورد', payload.provider),
                line('الحالة', payload.status || payload.message),
                'Winnie',
            ],
        },
        verification_code: {
            title: 'كود تفعيل واتساب',
            message: [
                `كود تفعيل واتساب في Winnie: ${payload.code}`,
                'ينتهي خلال 10 دقائق.',
            ],
        },
        test_message: {
            title: 'رسالة تجربة',
            message: [
                payload.message || 'هذه رسالة تجربة من Winnie ✅',
                'Winnie',
            ],
        },
    };

    const template = templates[eventType] || {
        title: payload.title || 'Winnie',
        message: [payload.message || 'إشعار جديد من Winnie', 'Winnie'],
    };

    return {
        title: template.title,
        message: template.message.filter(Boolean).join('\n').slice(0, 1200),
    };
};

module.exports = { renderTemplate };
