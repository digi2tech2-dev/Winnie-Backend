'use strict';

const { body, param, query } = require('express-validator');
const {
    GROUP_REQUEST_TYPES,
    GROUP_REQUEST_STATUS,
} = require('./groupRequest.constants');

const paginationValidation = [
    query('page').optional().isInt({ min: 1 }).withMessage('page must be a positive integer'),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('limit must be between 1 and 100'),
];

const dateFilterValidation = [
    query('from').optional().isISO8601().withMessage('from must be an ISO date'),
    query('to').optional().isISO8601().withMessage('to must be an ISO date'),
];

const requestIdValidation = [
    param('id').isMongoId().withMessage('id must be a valid Mongo ID'),
];

const optionalMongoBody = (field) =>
    body(field)
        .optional({ nullable: true, checkFalsy: true })
        .isMongoId()
        .withMessage(`${field} must be a valid Mongo ID`);

const optionalMongoQuery = (field) =>
    query(field)
        .optional({ nullable: true, checkFalsy: true })
        .isMongoId()
        .withMessage(`${field} must be a valid Mongo ID`);

const createGroupRequestValidation = [
    body('requestType')
        .isIn(Object.values(GROUP_REQUEST_TYPES))
        .withMessage('requestType must be GROUP_CHANGE or SUB_AGENT'),
    optionalMongoBody('requestedGroupId'),
    body('reason')
        .optional({ nullable: true })
        .isString().withMessage('reason must be a string')
        .trim()
        .isLength({ max: 1000 }).withMessage('reason cannot exceed 1000 characters'),
    body()
        .custom((value) => {
            if (value.requestType === GROUP_REQUEST_TYPES.GROUP_CHANGE && !value.requestedGroupId) {
                throw new Error('requestedGroupId is required for GROUP_CHANGE requests');
            }
            return true;
        }),
];

const myGroupRequestListValidation = [
    ...paginationValidation,
    query('status')
        .optional()
        .isIn(Object.values(GROUP_REQUEST_STATUS))
        .withMessage('status must be PENDING, APPROVED, REJECTED, or CANCELED'),
    query('requestType')
        .optional()
        .isIn(Object.values(GROUP_REQUEST_TYPES))
        .withMessage('requestType must be GROUP_CHANGE or SUB_AGENT'),
];

const adminGroupRequestListValidation = [
    ...paginationValidation,
    ...dateFilterValidation,
    optionalMongoQuery('userId'),
    optionalMongoQuery('requestedGroupId'),
    query('status')
        .optional()
        .isIn(Object.values(GROUP_REQUEST_STATUS))
        .withMessage('status must be PENDING, APPROVED, REJECTED, or CANCELED'),
    query('requestType')
        .optional()
        .isIn(Object.values(GROUP_REQUEST_TYPES))
        .withMessage('requestType must be GROUP_CHANGE or SUB_AGENT'),
];

const approveGroupRequestValidation = [
    ...requestIdValidation,
    optionalMongoBody('approvedGroupId'),
    body('adminNote')
        .optional({ nullable: true })
        .isString().withMessage('adminNote must be a string')
        .trim()
        .isLength({ max: 1000 }).withMessage('adminNote cannot exceed 1000 characters'),
];

const rejectGroupRequestValidation = [
    ...requestIdValidation,
    body('adminNote')
        .optional({ nullable: true })
        .isString().withMessage('adminNote must be a string')
        .trim()
        .isLength({ max: 1000 }).withMessage('adminNote cannot exceed 1000 characters'),
];

module.exports = {
    createGroupRequestValidation,
    myGroupRequestListValidation,
    adminGroupRequestListValidation,
    requestIdValidation,
    approveGroupRequestValidation,
    rejectGroupRequestValidation,
};
