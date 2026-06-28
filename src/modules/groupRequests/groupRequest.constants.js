'use strict';

const GROUP_REQUEST_TYPES = Object.freeze({
    GROUP_CHANGE: 'GROUP_CHANGE',
    SUB_AGENT: 'SUB_AGENT',
});

const GROUP_REQUEST_STATUS = Object.freeze({
    PENDING: 'PENDING',
    APPROVED: 'APPROVED',
    REJECTED: 'REJECTED',
    CANCELED: 'CANCELED',
});

const GROUP_REQUEST_PERMISSIONS = Object.freeze({
    VIEW: 'groupRequests.view',
    MANAGE: 'groupRequests.manage',
});

module.exports = {
    GROUP_REQUEST_TYPES,
    GROUP_REQUEST_STATUS,
    GROUP_REQUEST_PERMISSIONS,
};
