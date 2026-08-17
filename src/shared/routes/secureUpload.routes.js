'use strict';

const { Router } = require('express');
const path = require('path');
const catchAsync = require('../utils/catchAsync');
const {
    getContentType,
    isInlineContent,
    verifySignedUpload,
} = require('../utils/secureUploadSigner');

const router = Router();

router.get('/file', catchAsync(async (req, res) => {
    const file = verifySignedUpload({
        payload: req.query.payload,
        signature: req.query.signature,
    });
    const contentType = getContentType(file.filename);
    const disposition = isInlineContent(file.filename) ? 'inline' : 'attachment';

    res.set('Cache-Control', 'private, no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Type', contentType);
    res.set('Content-Disposition', `${disposition}; filename="${path.basename(file.filename).replace(/"/g, '')}"`);
    res.sendFile(file.absolutePath);
}));

module.exports = router;
